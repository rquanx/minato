import { z } from "zod";
import type { connectDatabase } from "../../packages/db/client";
import { candidate, type createLiteLlm } from "../../packages/litellm/client";
import { runtimeRouteKey, type createRuntime } from "../../packages/runtime/client";

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
    returning r.feature_id, r.version::text as version, r.candidates, r.approved_policy`;
  if (!route) return false;
  try {
    const candidates = z.array(candidate).parse(route.candidates);
    if ("publishRoute" in proxy) await proxy.publishRoute(route.feature_id, route.version, candidates);
    else await proxy.publish(runtimeRouteKey(route.feature_id, route.version), route.version, candidates);
    await db.begin(async (tx) => {
      const [feature] = await tx`select desired_version::text as desired from features where id = ${route.feature_id} for update`;
      const state = feature.desired === route.version ? "active" : "superseded";
      const [committed] = await tx`update route_versions set state = ${state}, lease_until = null, lease_token = null
        where feature_id = ${route.feature_id} and version = ${route.version}::bigint and lease_token = ${lease}
        returning feature_id`;
      if (committed && state === "active") {
        await tx`update features set active_version = ${route.version}::bigint, unavailable = false,
          approved_policy = ${route.approved_policy ? JSON.stringify(route.approved_policy) : null}::text::jsonb
          where id = ${route.feature_id}`;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = /^(?:proxy|upstream|runtime)_[a-z_]+$/.test(message) ? message : "route_preparation_failed";
    await db`update route_versions set state = 'failed', error_code = ${code}, lease_until = null, lease_token = null
      where feature_id = ${route.feature_id} and version = ${route.version}::bigint and lease_token = ${lease}`;
  }
  return true;
}

