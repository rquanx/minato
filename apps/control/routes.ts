import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, uuid } from "../../packages/contracts";
import { defaultPool, policy, previewCandidates } from "../../packages/db/routing-policy";
import { candidate } from "../../packages/litellm/client";
import type { Database } from "./auth";

const id = z.object({ id: uuid });
const revision = z.number().int().nonnegative();
const version = z.string().regex(/^[1-9]\d{0,17}$/);
const draft = z.union([
  z.strictObject({ expectedRevision: revision, candidates: z.array(candidate).min(1).max(3) }),
  z.strictObject({ expectedRevision: revision, policy }),
]);

export function registerRoutes(app: FastifyInstance, db: Database) {
  app.get("/admin/v1/environments/:id/features", async (request) => {
    const params = id.parse(request.params);
    return db`select f.id, f.slug, f.alias, f.declaration, f.draft, f.routing_policy as "routingPolicy",
      f.draft_revision as "draftRevision", f.unavailable, f.route_reason as "routeReason",
      f.active_version::text as "activeRouteVersion", f.desired_version::text as "desiredRouteVersion",
      active.candidates as "activeModels", desired.state as "desiredRouteState"
      from features f left join route_versions active on (active.feature_id, active.version) = (f.id, f.active_version)
      left join route_versions desired on (desired.feature_id, desired.version) = (f.id, f.desired_version)
      where f.environment_id = ${params.id} order by f.created_at desc limit 200`;
  });

  app.put("/admin/v1/features/:id/routing", async (request) => {
    const params = id.parse(request.params);
    const input = draft.parse(request.body);
    const candidates = "candidates" in input ? input.candidates : null;
    if (candidates) {
      const dedup = new Set(candidates.map((entry) => JSON.stringify([entry.sourceId, entry.modelId])));
      if (dedup.size !== candidates.length) throw new ApiError(422, "duplicate_candidate", "Route candidates must be distinct");
    }
    const [updated] = await db`update features
      set draft = ${JSON.stringify(candidates)}::text::jsonb,
        routing_policy = ${"policy" in input ? JSON.stringify(input.policy) : null}::text::jsonb,
        draft_revision = draft_revision + 1
      where id = ${params.id} and draft_revision = ${input.expectedRevision}
      returning draft_revision as "draftRevision", draft`;
    if (!updated) throw new ApiError(409, "stale_draft", "Draft revision is stale");
    return updated;
  });

  app.post("/admin/v1/features/:id/routing/preview", async (request) => {
    const params = id.parse(request.params);
    const proposed = request.body === undefined ? undefined : policy.parse(request.body);
    const [feature] = await db`select draft_revision as "draftRevision", draft as candidates, routing_policy,
      declaration, environment_id, registration_revision as "registrationRevision"
      from features where id = ${params.id}`;
    if (!feature) throw new ApiError(404, "feature_not_found", "Feature not found");
    if (!proposed && !feature.routing_policy) {
      const candidates = z.array(candidate).parse(feature.candidates ?? []);
      const attemptOrder = candidates.map(({ sourceId, modelId }) => ({ sourceId, modelId, origin: "feature" }));
      return { draftRevision: feature.draftRevision, candidates, attemptOrder, excluded: [] };
    }
    return {
      draftRevision: feature.draftRevision, registrationRevision: feature.registrationRevision,
      ...await previewCandidates(db, feature, proposed ?? policy.parse(feature.routing_policy)),
    };
  });

  app.put("/admin/v1/environments/:id/defaults", async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { pool } = z.strictObject({ pool: defaultPool }).parse(request.body);
    await db.begin(async (tx) => {
      const [environment] = await tx`update environments set default_pool = ${JSON.stringify(pool)}::text::jsonb,
        settings_revision = settings_revision + 1 where id = ${id} returning id`;
      if (!environment) throw new ApiError(404, "environment_not_found", "Environment not found");
      await tx`update features set reconcile_needed = true where environment_id = ${id} and approved_policy is not null`;
    });
    return { pool };
  });

  app.get("/admin/v1/environments/:id/defaults", async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const [result] = await db`select default_pool as pool, auto_publish_routes as "autoPublish" from environments where id = ${id}`;
    if (!result) throw new ApiError(404, "environment_not_found", "Environment not found");
    return result;
  });
  app.put("/admin/v1/environments/:id/auto-publish", async (request) => {
    const { id: environment } = id.parse(request.params);
    const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(request.body);
    const [row] = await db`update environments set auto_publish_routes = ${enabled}
      where id = ${environment} and archived_at is null returning auto_publish_routes as "autoPublish"`;
    if (!row) throw new ApiError(404, "environment_not_found", "Environment not found");
    return row;
  });

  async function enqueue(featureId: string, selection: { revision: number } | { version: string; active: string }) {
    return db.begin(async (tx) => {
      const [feature] = await tx`select draft, draft_revision, declaration, environment_id, routing_policy, declaration->'requirements' as requirements,
        active_version::text as active_version from features where id = ${featureId} for update`;
      if (!feature) throw new ApiError(404, "feature_not_found", "Feature not found");
      let candidates = feature.draft;
      let requirements = feature.requirements;
      let approvedPolicy = feature.routing_policy;
      if ("revision" in selection) {
        if (selection.revision !== feature.draft_revision) throw new ApiError(409, "stale_draft", "Draft revision is stale");
        if (feature.routing_policy) {
          const preview = await previewCandidates(tx, feature, policy.parse(feature.routing_policy));
          candidates = preview.candidates;
          requirements = preview.requirements;
        }
      } else {
        if (selection.active !== feature.active_version) throw new ApiError(409, "stale_route", "Active route has changed");
        const [old] = await tx`select candidates, requirements, approved_policy from route_versions
          where feature_id = ${featureId} and version = ${selection.version}::bigint and state = 'active'`;
        if (!old) throw new ApiError(404, "route_not_found", "Published route version not found");
        candidates = old.candidates;
        requirements = old.requirements;
        approvedPolicy = old.approved_policy;
        if (approvedPolicy) {
          const preview = await previewCandidates(tx, feature, policy.parse(approvedPolicy));
          candidates = preview.candidates;
          requirements = preview.requirements;
        }
      }
      if (!candidates?.length) throw new ApiError(422, "no_candidates", "Set eligible route candidates before publishing");
      if (requirements.endpoint === "embeddings" && !approvedPolicy && candidates.length > 1) {
        throw new ApiError(422, "embedding_fallback_requires_policy", "Configure a shared embedding space and dimensions before adding alternate models");
      }
      const [route] = await tx`insert into route_versions (feature_id, version, candidates, requirements, approved_policy)
        select ${featureId}, coalesce(max(version), 0) + 1, ${JSON.stringify(candidates)}::text::jsonb,
          ${JSON.stringify(requirements)}::text::jsonb, ${approvedPolicy ? JSON.stringify(approvedPolicy) : null}::text::jsonb
        from route_versions where feature_id = ${featureId} returning version::text as version, state`;
      await tx`update features set desired_version = ${route.version}::bigint, reconcile_needed = false where id = ${featureId}`;
      await tx`insert into admin_events (actor, action, entity_id)
        values ('admin', ${"revision" in selection ? "route.publish_queued" : "route.rollback_queued"}, ${featureId})`;
      return { featureId, ...route };
    });
  }

  app.post("/admin/v1/features/:id/routing/publish", async (request, reply) => {
    const params = id.parse(request.params);
    const input = z.strictObject({ expectedRevision: revision }).parse(request.body);
    return reply.code(202).send(await enqueue(params.id, { revision: input.expectedRevision }));
  });

  app.post("/admin/v1/features/:id/routing/rollback", async (request, reply) => {
    const params = id.parse(request.params);
    const input = z.strictObject({ version, expectedActiveVersion: version }).parse(request.body);
    return reply.code(202).send(await enqueue(params.id, { version: input.version, active: input.expectedActiveVersion }));
  });

  app.get("/admin/v1/features/:id/routing/versions", async (request) => {
    const params = id.parse(request.params);
    const query = z.object({ before: version.optional(), pageSize: z.coerce.number().int().min(1).max(50).optional() }).parse(request.query);
    if (query.pageSize) {
      const rows = await db`select version::text as version, state, error_code as "errorCode", created_at as "createdAt"
        from route_versions where feature_id = ${params.id} and version < coalesce(${query.before ?? null}::bigint, 9223372036854775807)
        order by route_versions.version desc limit ${query.pageSize + 1}`;
      const items = rows.slice(0, query.pageSize);
      return { items, before: rows.length > query.pageSize ? items.at(-1)?.version : null };
    }
    return db`select version::text as version, state, error_code as "errorCode", created_at as "createdAt"
      from route_versions where feature_id = ${params.id} order by version desc limit 200`;
  });

  app.get("/admin/v1/features/:id/routing/versions/:version", async (request) => {
    const params = id.extend({ version }).parse(request.params);
    const [row] = await db`select r.version::text as version, r.state, r.error_code as "errorCode", r.created_at as "createdAt",
      r.candidates, r.approved_policy as policy, r.requirements, f.active_version::text as "activeVersion"
      from route_versions r join features f on f.id = r.feature_id
      where r.feature_id = ${params.id} and r.version = ${params.version}::bigint`;
    if (!row) throw new ApiError(404, "route_not_found", "Route version not found");
    return { ...row, candidates: row.candidates.map(({ sourceId, modelId }: z.infer<typeof candidate>) => ({ sourceId, modelId })) };
  });
}
