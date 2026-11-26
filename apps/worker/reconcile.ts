import type { connectDatabase } from "../../packages/db/client";
import { policy, previewCandidates } from "../../packages/db/routing-policy";
import { recordRouteEvent } from "../../packages/db/model-notifications";

export async function reconcileNextFeature(db: ReturnType<typeof connectDatabase>) {
  return db.begin(async (tx) => {
    const [feature] = await tx`select id, environment_id, declaration, approved_policy,
      desired_version, active_version, unavailable from features f where reconcile_needed and approved_policy is not null
      and not exists (select 1 from route_versions r where r.feature_id = f.id and r.version = f.desired_version
        and r.state in ('queued', 'preparing') and r.origin = 'manual')
      order by id limit 1 for update of f skip locked`;
    if (!feature) return false;
    const { candidates, requirements } = await previewCandidates(tx, feature, policy.parse(feature.approved_policy));
    if (requirements.endpoint === "embeddings" && feature.active_version && !(requirements.embeddingSpace && requirements.embeddingDimensions)) {
      const [active] = await tx`select candidates from route_versions where feature_id = ${feature.id} and version = ${feature.active_version}`;
      const current = active?.candidates?.[0];
      if (current && candidates.some((entry) => entry.sourceId !== current.sourceId || entry.modelId !== current.modelId)) {
        candidates.length = 0;
      }
    }
    if (!candidates.length) {
      await tx`update features set unavailable = true, route_reason = 'no_eligible_model',
        desired_version = null, reconcile_needed = false where id = ${feature.id}`;
      if (!feature.unavailable) await recordRouteEvent(tx, feature.id, "no_eligible_model");
      return true;
    }
    const serialized = JSON.stringify(candidates);
    const contract = JSON.stringify(requirements);
    const [matching] = await tx`select version from route_versions where feature_id = ${feature.id}
      and version = ${feature.desired_version} and state in ('queued', 'preparing', 'active')
      and candidates = ${serialized}::text::jsonb and requirements = ${contract}::text::jsonb`;
    if (!matching) {
      const [queued] = await tx`insert into route_versions (feature_id, version, candidates, requirements, approved_policy, origin)
        select ${feature.id}, coalesce(max(version), 0) + 1, ${serialized}::text::jsonb, ${contract}::text::jsonb,
        ${JSON.stringify(feature.approved_policy)}::text::jsonb, 'automatic'
        from route_versions where feature_id = ${feature.id} returning version`;
      await tx`update features set desired_version = ${queued.version} where id = ${feature.id}`;
    }
    await tx`update features set reconcile_needed = false where id = ${feature.id}`;
    return true;
  });
}
