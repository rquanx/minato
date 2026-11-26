import { z } from "zod";
import { featureDeclaration, modelReference } from "../contracts";
import { candidate } from "../litellm/client";
import type { connectDatabase } from "./client";
import { ApiError } from "../contracts";
import { providerDefaultEndpoints, relativeProviderBase, subscriptionRelay, type ProviderKind } from "../contracts/providers";

export const policy = z.union([z.strictObject({
  primary: modelReference.optional(),
  fallbacks: z.array(modelReference).max(12).default([]),
}), z.strictObject({ orderedModels: z.array(modelReference).max(13), useRegistrationPreference: z.boolean().optional() })]);
export type RoutePolicy = z.infer<typeof policy>;
export const defaultPool = z.array(modelReference).max(50);
type Query = Pick<ReturnType<typeof connectDatabase>, "unsafe">;
export type RouteCandidateOrigin = "feature" | "registration" | "environment";

export async function previewCandidates(db: Query, feature: { declaration: unknown; environment_id: string }, approved: RoutePolicy) {
  const declaration = featureDeclaration.parse(feature.declaration);
  const [environment] = await db.unsafe("select default_pool, settings_revision from environments where id = $1", [feature.environment_id]);
  if (!environment) throw new ApiError(404, "environment_not_found", "Environment not found");
  const withOrigin = (origin: RouteCandidateOrigin) =>
    (reference: z.infer<typeof modelReference> | undefined) => ({ reference, origin });
  const configured = "orderedModels" in approved
    ? approved.orderedModels.length || approved.useRegistrationPreference === false
      ? approved.orderedModels.map(withOrigin("feature")) : [withOrigin("registration")(declaration.preferredModel)]
    : [approved.primary ? withOrigin("feature")(approved.primary) : withOrigin("registration")(declaration.preferredModel),
      ...approved.fallbacks.map(withOrigin("feature"))];
  const references = [...configured, ...defaultPool.parse(environment.default_pool).map(withOrigin("environment"))];
  const seen = new Set<string>();
  const selected: z.infer<typeof candidate>[] = [];
  const attemptOrder: (z.infer<typeof modelReference> & { origin: RouteCandidateOrigin })[] = [];
  const excluded: (typeof attemptOrder[number] & { reason: string })[] = [];
  const sourceVersions: Record<string, { revision: number; syncedAt: string | null }> = {};
  const requirements = declaration.requirements;
  for (const { reference, origin } of references) {
    if (!reference) continue;
    const { sourceId, modelId } = reference;
    const key = JSON.stringify([sourceId, modelId]);
    if (seen.has(key)) continue;
    seen.add(key);
    const [row] = await db.unsafe(`select s.slug, s.kind, s.api_base, s.default_endpoint, s.credential_env, s.credential_id,
      s.revision, s.last_success_at, s.enabled, c.token_version, c.expires_at, c.refresh_error, m.*
      from sources s join source_models m on m.source_id = s.id
      left join source_credentials c on c.id = s.credential_id
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
      : !row.credential_id && (!row.credential_env || subscriptionRelay(row.kind)) ? "credential_missing"
      : row.refresh_error === "reauthorization_required" || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) ? "credential_expired"
      : metadata.protocolUnsupported && !row.capability_override?.upstreamEndpoint ? "endpoint_mismatch"
      : row.kind === "codex" && upstreamEndpoint !== "responses" ? "endpoint_mismatch"
      : subscriptionRelay(row.kind) && upstreamEndpoint !== providerDefaultEndpoints[row.kind as ProviderKind] ? "endpoint_mismatch"
      : !protocolCompatible ? "endpoint_mismatch"
      : requirements.endpoint === "embeddings" && requirements.embeddingSpace && metadata.embeddingSpace !== requirements.embeddingSpace
        ? "embedding_space_mismatch"
      : requirements.endpoint === "embeddings" && requirements.embeddingDimensions && metadata.embeddingDimensions !== requirements.embeddingDimensions
        ? "embedding_dimensions_mismatch"
      : requirements.endpoint === "embeddings" && selected.length > 0 && !(requirements.embeddingSpace && requirements.embeddingDimensions)
        ? "embedding_fallback_requires_matching_space_and_dimensions"
      : requirements.minContextTokens && !(metadata.contextTokens >= requirements.minContextTokens) ? "context_mismatch"
      : requirements.structuredOutput && !structured ? "structured_output_mismatch"
      : requirements.streaming && metadata.streaming !== true ? "streaming_unknown"
      : requirements.tools && metadata.tools !== true ? "tools_unknown"
      : selected.length >= 3 ? "candidate_limit" : undefined;
    if (reason) {
      excluded.push({ sourceId: row?.slug ?? sourceId, modelId, reason, origin });
      continue;
    }
    selected.push(candidate.parse({
      sourceId: row.slug, modelId, apiBase: metadata.apiBase ?? row.api_base,
      credentialEnv: row.credential_env ?? undefined, credentialId: row.credential_id ?? undefined,
      credentialVersion: row.token_version || undefined,
      codex: row.kind === "codex" ? true : undefined,
      subscription: subscriptionRelay(row.kind) ? row.kind : undefined,
      relativeApiBase: relativeProviderBase(row.kind) ? true : undefined, upstreamEndpoint,
    }));
    attemptOrder.push({ sourceId: row.slug, modelId, origin });
  }
  return { candidates: selected, attemptOrder, excluded, requirements, sourceVersions, environmentRevision: environment.settings_revision };
}
