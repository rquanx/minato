import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, slug, uuid } from "../../packages/contracts";
import { providerDefaultEndpoints } from "../../packages/contracts/providers";
import { capabilities, sourceFields, validateUrl } from "../../packages/litellm/catalog";
import type { Auth, Database } from "./auth";
import { subscriptionOAuth } from "../../packages/litellm/subscription-auth";
import { googleSubscription, providerUrls, subscriptionRelay, type ProviderKind } from "../../packages/contracts/providers";
import { codexBase } from "../../packages/litellm/codex-auth";
import { verifyModel } from "./model-verification";
import { cpaManagement, registerCpaAuthFiles } from "./cpa-auth-files";
import { registerSourceCredentials } from "./source-credentials";
import { readSourceCredential } from "../../packages/db/source-credentials";

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
function sourceDirectory(input: { directoryUrl?: string; apiBase: string; directoryEnabled: boolean; kind: string }) {
  if (!input.directoryUrl && input.directoryEnabled) {
    throw new ApiError(422, "directory_url_required", "Enter a directory URL or disable directory synchronization");
  }
  const directoryUrl = input.directoryUrl ?? input.apiBase;
  validateSource(directoryUrl, input.apiBase);
  if (subscriptionRelay(input.kind)) {
    const urls = providerUrls[input.kind as ProviderKind]!;
    if (input.credentialEnv || input.apiBase.replace(/\/$/, "") !== urls.base
      || (input.directoryEnabled && (googleSubscription(input.kind) || directoryUrl !== urls.directory))) {
      throw new ApiError(422, "invalid_subscription_origin", "Use the provider endpoint and its supported directory settings");
    }
  }
  if (input.kind === "codex" && (input.apiBase.replace(/\/$/, "") !== codexBase ||
    (input.directoryEnabled && (new URL(directoryUrl).origin + new URL(directoryUrl).pathname !== codexBase + "/models")))) {
    throw new ApiError(422, "invalid_codex_origin", "Use the official Codex endpoint for this source");
  }
  return directoryUrl;
}

export function registerCatalog(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv, auth: Auth) {
  registerCpaAuthFiles(app, db, env);
  registerSourceCredentials(app, db, env, auth);
  const credentialFor = readSourceCredential(db, env);
  app.get("/admin/v1/sources", async () => (await db`select s.id, s.slug, s.kind, s.enabled, s.sync_state as "syncState",
    s.last_success_at as "lastSuccessAt", s.directory_url as "directoryUrl", s.api_base as "apiBase",
    s.default_endpoint as "defaultEndpoint", s.credential_env as "credentialEnv", (s.credential_id is not null) as "managedCredential",
    s.directory_enabled as "directoryEnabled", s.account_id as "accountId", c.auth_type as "credentialType", c.expires_at as "credentialExpiresAt",
    c.refresh_error as "credentialError", s.revision
    from sources s left join source_credentials c on c.id = s.credential_id order by s.slug`).map((source) => {
      let oauthAvailable = false;
      try { oauthAvailable = Boolean(subscriptionOAuth(source.kind, source.slug, env)); } catch { /* Invalid OAuth deployment configuration. */ }
      return { ...source, oauthAvailable, cpaManagement: source.kind === "cpa" && Boolean(cpaManagement(source.slug, env)) };
    }));
  app.post("/admin/v1/sources", async (request, reply) => {
    const input = sourceFields.extend({ slug, defaultEndpoint: sourceFields.shape.defaultEndpoint.optional() }).parse(request.body);
    const directoryUrl = sourceDirectory(input);
    const defaultEndpoint = input.defaultEndpoint ?? providerDefaultEndpoints[input.kind];
    const [source] = await db`insert into sources (slug, kind, directory_url, api_base, credential_env, default_endpoint, enabled, directory_enabled)
      values (${input.slug}, ${input.kind}, ${directoryUrl}, ${input.apiBase},
        ${input.credentialEnv ?? null}, ${defaultEndpoint}, ${input.enabled}, ${input.directoryEnabled}) returning id, slug, revision`;
    return reply.code(201).send(source);
  });
  app.patch("/admin/v1/sources/:id", async (request) => {
    const { id } = idPath.parse(request.params);
    const input = sourceFields.extend({ expectedRevision: z.number().int().positive() }).parse(request.body);
    const directoryUrl = sourceDirectory(input);
    return db.begin(async (tx) => {
      const [source] = await tx`update sources set kind = ${input.kind}, enabled = ${input.enabled},
        directory_url = ${directoryUrl}, api_base = ${input.apiBase}, credential_env = ${input.credentialEnv ?? null},
        default_endpoint = ${input.defaultEndpoint}, directory_enabled = ${input.directoryEnabled},
        revision = revision + 1, lease_token = null, lease_until = null,
      sync_state = 'pending', next_sync_at = now() where id = ${id} and revision = ${input.expectedRevision}
        and (kind = ${input.kind} or (account_id is null
          and not exists (select 1 from subscription_accounts a where a.owner_source_id = sources.id)))
        returning id, slug, revision`;
      if (!source) throw new ApiError(409, "stale_source", "The source revision changed or an account holds its provider type");
      await tx`update source_models set verification = null where source_id = ${id} and verification is not null`;
      await tx`update features set reconcile_needed = true where approved_policy is not null`;
      return source;
    });
  });
  app.post("/admin/v1/sources/:id/sync", async (request, reply) => {
    const { id } = idPath.parse(request.params);
    const [source] = await db`update sources set next_sync_at = now() where id = ${id} and enabled and directory_enabled
      returning id, sync_state as "syncState"`;
    if (!source) throw new ApiError(404, "source_unavailable", "Source or directory sync is disabled");
    return reply.code(202).send(source);
  });
  app.get("/admin/v1/sources/:id/models", async (request) => {
    const { id } = idPath.parse(request.params);
    return db`select raw_model_id as "modelId", reported, capability_override as "capabilityOverride",
      status, manual, verification, last_seen_at as "lastSeenAt" from source_models where source_id = ${id} order by raw_model_id`;
  });
  app.post("/admin/v1/sources/:id/models", async (request, reply) => {
    const { id } = idPath.parse(request.params);
    const { modelId, ...settings } = capabilities.extend({ modelId: z.string().trim().min(1).max(256) }).parse(request.body);
    if (settings.apiBase) validateSource(settings.apiBase, settings.apiBase);
    await db.begin(async (tx) => {
      const [source] = await tx`select id from sources where id = ${id} for update`;
      if (!source) throw new ApiError(404, "source_not_found", "Source not found");
      const [saved] = await tx`insert into source_models (source_id, raw_model_id, capability_override, manual)
        values (${id}, ${modelId}, ${JSON.stringify(settings)}::text::jsonb, true)
        on conflict (source_id, raw_model_id) do update set manual = true, status = 'listed', missing_count = 0,
          capability_override = coalesce(source_models.capability_override, '{}'::jsonb) || excluded.capability_override,
          verification = null where not source_models.manual returning raw_model_id`;
      if (!saved) throw new ApiError(409, "model_already_manual", "This model is already managed manually");
      await tx`update features set reconcile_needed = true where approved_policy is not null`;
    });
    return reply.code(201).send({ modelId });
  });
  app.get("/admin/v1/sources/:id/diagnostics", async (request) => {
    const { id } = idPath.parse(request.params);
    const [source] = await db`select slug, directory_enabled as "directoryEnabled" from sources where id = ${id}`;
    if (!source) throw new ApiError(404, "source_not_found", "Source not found");
    const [sync, affected] = await Promise.all([
      db`select status, error_code as "errorCode", http_status as "httpStatus", recorded_at as "recordedAt",
        model_count as "modelCount" from source_syncs where source_id = ${id} order by recorded_at desc, id desc limit 1`,
      db`select f.alias, active.candidates->0->>'modelId' as "firstModel",
          jsonb_path_query_array(active.candidates, '$[*] ? (@.sourceId == $source).modelId',
            jsonb_build_object('source', ${source.slug}::text)) as models
        from features f join route_versions active on (active.feature_id, active.version) = (f.id, f.active_version)
        where not f.unavailable and active.candidates @> jsonb_build_array(jsonb_build_object('sourceId', ${source.slug}::text))
        order by f.alias limit 201`,
    ]);
    return { directoryEnabled: source.directoryEnabled, sync: sync[0] ?? null,
      affected: affected.slice(0, 200), affectedTruncated: affected.length > 200 };
  });
  app.put("/admin/v1/sources/:id/models/:model", async (request) => {
    const { id, model } = modelPath.parse(request.params);
    const input = capabilities.parse(request.body);
    if (input.apiBase) validateSource(input.apiBase, input.apiBase);
    await db.begin(async (tx) => {
      await tx`insert into source_models (source_id, raw_model_id, capability_override)
        values (${id}, ${model}, ${JSON.stringify(input)}::text::jsonb)
        on conflict (source_id, raw_model_id) do update set capability_override = excluded.capability_override,
          verification = case when source_models.capability_override is distinct from excluded.capability_override
            then null else source_models.verification end`;
      await tx`update features set reconcile_needed = true where approved_policy is not null`;
    });
    return { modelId: model };
  });
  const probing = new Set<string>();
  app.post("/admin/v1/sources/:id/models/:model/verify", async (request, reply) => {
    const { id, model } = modelPath.parse(request.params);
    const { prompt } = z.strictObject({ prompt: z.string().trim().min(1).max(2000).optional() }).parse(request.body ?? {});
    const [row] = await db`select s.slug, s.kind, s.revision, s.credential_env, s.credential_id, s.api_base, s.default_endpoint,
      s.enabled, m.status, m.reported, m.capability_override from sources s join source_models m on m.source_id = s.id
      where s.id = ${id} and m.raw_model_id = ${model}`;
    if (!row?.enabled || row.status !== "listed") throw new ApiError(422, "model_unavailable", "Select a listed model from an enabled source");
    const metadata = { ...row.reported, ...row.capability_override };
    if (metadata.protocolUnsupported && !row.capability_override?.upstreamEndpoint) {
      throw new ApiError(422, "unsupported_endpoint", "Set a protocol override before verifying this model");
    }
    const key = JSON.stringify([id, model]);
    if (probing.has(key)) throw new ApiError(409, "verification_in_progress", "Verification is already running");
    probing.add(key);
    try {
      const apiBase = metadata.apiBase ?? row.api_base;
      const bundle = row.credential_id
        ? await credentialFor(row.slug, row.credential_id, apiBase).catch(() => {
          throw new ApiError(422, "credential_unavailable", "Re-import the source credential for this endpoint");
        }) : undefined;
      const credential = bundle?.accessToken ?? (row.credential_env ? env[row.credential_env] : undefined);
      const { verification, sample } = await verifyModel({ modelId: model, apiBase,
        endpoint: metadata.upstreamEndpoint ?? row.default_endpoint, kind: row.kind }, credential, prompt, bundle);
      await db.begin(async (tx) => {
        const [current] = await tx`select revision from sources where id = ${id} for update`;
        const [saved] = current?.revision === row.revision ? await tx`update source_models set verification = ${JSON.stringify(verification)}::text::jsonb
          where source_id = ${id} and raw_model_id = ${model} and status = 'listed'
          and reported = ${JSON.stringify(row.reported)}::text::jsonb
          and capability_override is not distinct from ${row.capability_override ? JSON.stringify(row.capability_override) : null}::text::jsonb
          returning raw_model_id` : [];
        if (!saved) throw new ApiError(409, "stale_model_verification", "The model configuration changed during verification");
      });
      return reply.header("Cache-Control", "no-store").send({ ...verification, sample });
    } finally {
      probing.delete(key);
    }
  });
}
