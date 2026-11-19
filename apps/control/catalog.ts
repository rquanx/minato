import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, slug, uuid } from "../../packages/contracts";
import { capabilities, sourceFields, validateUrl } from "../../packages/litellm/catalog";
import type { Database } from "./auth";

const idPath = z.object({ id: uuid });
const modelPath = idPath.extend({ model: z.string().min(1).max(256) });

function validateSource(directoryUrl: string, apiBase: string) {
  try {
    validateUrl(directoryUrl);
    if (validateUrl(apiBase).search) throw new Error();
  } catch {
    throw new ApiError(422, "invalid_source_url", "Provide source URLs without credentials or fragments");
  }
}

export function registerCatalog(app: FastifyInstance, db: Database) {
  app.get("/admin/v1/sources", async () => db`select id, slug, kind, enabled, sync_state as "syncState",
    last_success_at as "lastSuccessAt", directory_url as "directoryUrl", api_base as "apiBase",
    default_endpoint as "defaultEndpoint", credential_env as "credentialEnv", revision from sources order by slug`);
  app.post("/admin/v1/sources", async (request, reply) => {
    const input = sourceFields.extend({ slug }).parse(request.body);
    validateSource(input.directoryUrl, input.apiBase);
    const [source] = await db`insert into sources (slug, kind, directory_url, api_base, credential_env, default_endpoint, enabled)
      values (${input.slug}, ${input.kind}, ${input.directoryUrl}, ${input.apiBase},
        ${input.credentialEnv}, ${input.defaultEndpoint}, ${input.enabled}) returning id, slug, revision`;
    return reply.code(201).send(source);
  });
  app.patch("/admin/v1/sources/:id", async (request) => {
    const { id } = idPath.parse(request.params);
    const input = sourceFields.extend({ expectedRevision: z.number().int().positive() }).parse(request.body);
    validateSource(input.directoryUrl, input.apiBase);
    return db.begin(async (tx) => {
      const [source] = await tx`update sources set kind = ${input.kind}, enabled = ${input.enabled},
        directory_url = ${input.directoryUrl}, api_base = ${input.apiBase}, credential_env = ${input.credentialEnv},
        default_endpoint = ${input.defaultEndpoint}, revision = revision + 1, lease_token = null, lease_until = null,
        sync_state = 'pending', next_sync_at = now() where id = ${id} and revision = ${input.expectedRevision}
        returning id, slug, revision`;
      if (!source) throw new ApiError(409, "stale_source", "Source revision has changed");
      await tx`update features set reconcile_needed = true where approved_policy is not null`;
      return source;
    });
  });
  app.post("/admin/v1/sources/:id/sync", async (request, reply) => {
    const { id } = idPath.parse(request.params);
    const [source] = await db`update sources set next_sync_at = now() where id = ${id} and enabled
      returning id, sync_state as "syncState"`;
    if (!source) throw new ApiError(404, "source_unavailable", "Source is disabled or missing");
    return reply.code(202).send(source);
  });
  app.get("/admin/v1/sources/:id/models", async (request) => {
    const { id } = idPath.parse(request.params);
    return db`select raw_model_id as "modelId", reported, capability_override as "capabilityOverride",
      status, last_seen_at as "lastSeenAt" from source_models where source_id = ${id} order by raw_model_id`;
  });
  app.put("/admin/v1/sources/:id/models/:model", async (request) => {
    const { id, model } = modelPath.parse(request.params);
    const input = capabilities.parse(request.body);
    if (input.apiBase) validateSource(input.apiBase, input.apiBase);
    await db.begin(async (tx) => {
      await tx`insert into source_models (source_id, raw_model_id, capability_override)
        values (${id}, ${model}, ${JSON.stringify(input)}::text::jsonb)
        on conflict (source_id, raw_model_id) do update set capability_override = excluded.capability_override`;
      await tx`update features set reconcile_needed = true where approved_policy is not null`;
    });
    return { modelId: model };
  });
}
