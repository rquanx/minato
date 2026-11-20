import { z } from "zod";
import { featureDeclaration, modelReference } from "../contracts";
import { candidate } from "../litellm/client";
import type { connectDatabase } from "./client";
import { ApiError } from "../contracts";

export const policy = z.strictObject({
  primary: modelReference.optional(),
  fallbacks: z.array(modelReference).max(12).default([]),
});
export type RoutePolicy = z.infer<typeof policy>;
export const defaultPool = z.array(modelReference).max(50);
type Query = Pick<ReturnType<typeof connectDatabase>, "unsafe">;

export async function previewCandidates(db: Query, feature: { declaration: unknown; environment_id: string }, approved: RoutePolicy) {
  const declaration = featureDeclaration.parse(feature.declaration);
  const [environment] = await db.unsafe("select default_pool, settings_revision from environments where id = $1", [feature.environment_id]);
  if (!environment) throw new ApiError(404, "environment_not_found", "Environment not found");
  const references = [approved.primary ?? declaration.preferredModel, ...approved.fallbacks, ...defaultPool.parse(environment.default_pool)];
  const seen = new Set<string>();
  const selected: z.infer<typeof candidate>[] = [];
  const excluded: { sourceId: string; modelId: string; reason: string }[] = [];
  const sourceVersions: Record<string, { revision: number; syncedAt: string | null }> = {};
  const requirements = declaration.requirements;
  for (const reference of references) {
    if (!reference) continue;
    const { sourceId, modelId } = reference;
    const key = JSON.stringify([sourceId, modelId]);
    if (seen.has(key)) continue;
    seen.add(key);
    const [row] = await db.unsafe(`select s.slug, s.api_base, s.default_endpoint, s.credential_env,
      s.revision, s.last_success_at, s.enabled, m.*
      from sources s join source_models m on m.source_id = s.id
      where (s.slug = $1 or s.id::text = $1) and m.raw_model_id = $2`, [sourceId, modelId]);
    const metadata = { ...row?.reported, ...row?.capability_override };
    if (row) sourceVersions[row.slug] = { revision: row.revision, syncedAt: row.last_success_at };
    const upstreamEndpoint = metadata.upstreamEndpoint ?? row?.default_endpoint;
    const structured = metadata.structuredOutput === "json_schema" || metadata.structuredOutput === requirements.structuredOutput;
    const protocolCompatible = requirements.endpoint === upstreamEndpoint ||
      (requirements.endpoint === "responses" && upstreamEndpoint === "chat-completions") ||
      (requirements.endpoint === "chat-completions" && upstreamEndpoint === "responses");
    const reason = !row ? "model_unknown"
      : !row.enabled || row.status !== "listed" ? "model_unavailable"
      : !protocolCompatible ? "endpoint_mismatch"
      : requirements.minContextTokens && !(metadata.contextTokens >= requirements.minContextTokens) ? "context_mismatch"
      : requirements.structuredOutput && !structured ? "structured_output_mismatch"
      : requirements.streaming && metadata.streaming !== true ? "streaming_unknown"
      : requirements.tools && metadata.tools !== true ? "tools_unknown"
      : selected.length >= 3 ? "candidate_limit" : undefined;
    if (reason) excluded.push({ ...reference, reason });
    else selected.push(candidate.parse({
      sourceId: row.slug, modelId, apiBase: metadata.apiBase ?? row.api_base,
      credentialEnv: row.credential_env, upstreamEndpoint,
    }));
  }
  return { candidates: selected, excluded, requirements, sourceVersions, environmentRevision: environment.settings_revision };
}
