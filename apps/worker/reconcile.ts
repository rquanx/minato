import type { connectDatabase } from "../../packages/db/client";
import { policy, previewCandidates } from "../../packages/db/routing-policy";

export async function reconcileNextFeature(db: ReturnType<typeof connectDatabase>) {
  return db.begin(async (tx) => {
    const [feature] = await tx`select id, environment_id, declaration, approved_policy,
      desired_version from features where reconcile_needed and approved_policy is not null
      order by id limit 1 for update skip locked`;
    if (!feature) return false;
    const { candidates, requirements } = await previewCandidates(tx, feature, policy.parse(feature.approved_policy));
    if (!candidates.length) {
      await tx`update features set unavailable = true, desired_version = null, reconcile_needed = false where id = ${feature.id}`;
      return true;
    }
    const serialized = JSON.stringify(candidates);
    const contract = JSON.stringify(requirements);
    const [matching] = await tx`select version from route_versions where feature_id = ${feature.id}
      and version = ${feature.desired_version} and state in ('queued', 'preparing', 'active')
      and candidates = ${serialized}::text::jsonb and requirements = ${contract}::text::jsonb`;
    if (!matching) {
      const [queued] = await tx`insert into route_versions (feature_id, version, candidates, requirements, approved_policy)
        select ${feature.id}, coalesce(max(version), 0) + 1, ${serialized}::text::jsonb, ${contract}::text::jsonb,
        ${JSON.stringify(feature.approved_policy)}::text::jsonb
        from route_versions where feature_id = ${feature.id} returning version`;
      await tx`update features set desired_version = ${queued.version} where id = ${feature.id}`;
    }
    await tx`update features set reconcile_needed = false where id = ${feature.id}`;
    return true;
  });
}
