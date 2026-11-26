import { z } from "zod";
import type { connectDatabase } from "../../packages/db/client";
import { candidate, type createLiteLlm } from "../../packages/litellm/client";
import { runtimeFallbackKey, runtimeRouteKey, type createRuntime } from "../../packages/runtime/client";
import { recordRouteEvent } from "../../packages/db/model-notifications";

type RoutePublisher = ReturnType<typeof createLiteLlm> | ReturnType<typeof createRuntime>;

export async function publishNextRoute(
  db: ReturnType<typeof connectDatabase>,
  proxy: RoutePublisher,
) {
  const lease = crypto.randomUUID();
  const [route] = await db`update route_versions r
    set state = 'preparing', lease_until = now() + interval '3 minutes', lease_token = ${lease}
    from (select feature_id, version from route_versions
      where state = 'queued' or (state = 'preparing' and lease_until < now())
      order by created_at for update skip locked limit 1) as next
    where r.feature_id = next.feature_id and r.version = next.version
    returning r.feature_id, r.version::text as version, r.candidates, r.approved_policy, r.origin`;
  if (!route) return false;
  try {
    const candidates = z.array(candidate).parse(route.candidates);
    if ("publishRoute" in proxy) await proxy.publishRoute(route.feature_id, route.version, candidates);
    else await proxy.publish(runtimeRouteKey(route.feature_id, route.version), route.version, candidates);
    await db.begin(async (tx) => {
      const [feature] = await tx`select desired_version::text as desired from features where id = ${route.feature_id} for update`;
      const state = feature.desired === route.version ? "active" : "superseded";
      const [committed] = await tx`update route_versions set state = ${state}, finished_at = now(), lease_until = null, lease_token = null
        where feature_id = ${route.feature_id} and version = ${route.version}::bigint and lease_token = ${lease}
        returning feature_id`;
      if (committed && state === "active") {
        await tx`update features set active_version = ${route.version}::bigint, unavailable = false,
          route_reason = ${route.origin === "automatic" ? "policy_reconciled" : "manual_publication"},
          approved_policy = ${route.approved_policy ? JSON.stringify(route.approved_policy) : null}::text::jsonb
          where id = ${route.feature_id}`;
        if (route.origin === "automatic") await recordRouteEvent(tx, route.feature_id, "policy_reconciled", route.version);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = /^(?:proxy|upstream|runtime)_[a-z_]+$/.test(message) ? message : "route_preparation_failed";
    await db`update route_versions set state = 'failed', error_code = ${code}, finished_at = now(), lease_until = null, lease_token = null
      where feature_id = ${route.feature_id} and version = ${route.version}::bigint and lease_token = ${lease}`;
  }
  return true;
}

export async function retireRuntimeRoutes(db: ReturnType<typeof connectDatabase>, proxy: ReturnType<typeof createRuntime>) {
  const rows = await db`select r.feature_id, r.version::text as version, jsonb_array_length(r.candidates) as candidates from route_versions r
    join features f on f.id = r.feature_id
    left join route_versions serving on (serving.feature_id, serving.version) = (f.id, f.active_version)
    where r.runtime_retired_at is null and r.state in ('active','failed','superseded')
    and greatest(coalesce(r.finished_at, r.created_at), coalesce(serving.finished_at, serving.created_at))
      < now() - interval '10 minutes'
    and r.version is distinct from f.active_version and r.version is distinct from f.desired_version
    order by r.created_at limit 100`;
  for (const row of rows) {
    const key = runtimeRouteKey(row.feature_id, row.version);
    await Promise.all([proxy.remove(key), ...Array.from({ length: row.candidates - 1 }, (_, index) =>
      proxy.remove(runtimeFallbackKey(key, index + 1)))]);
    await db`update route_versions set runtime_retired_at = now()
      where feature_id = ${row.feature_id} and version = ${row.version}::bigint`;
  }
  const tests = await db`select id from tests where runtime_retired_at is null
    and target->>'mode' = 'specific_model' and started_at < now() - interval '10 minutes'
    order by started_at limit 100`;
  for (const row of tests) {
    await proxy.remove(`minato-test-${row.id}`);
    await db`update tests set runtime_retired_at = now() where id = ${row.id}`;
  }
}

