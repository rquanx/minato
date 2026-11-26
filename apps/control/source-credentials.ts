import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, uuid } from "../../packages/contracts";
import { credentialCipher } from "../../packages/db/source-credentials";
import { catalogFailure, readCatalog } from "../../packages/litellm/catalog";
import { upstreamDescription } from "../../packages/contracts/upstream-errors";
import type { Auth, Database } from "./auth";
import { verifyModel } from "./model-verification";
import { refreshDate, serviceAccount, serviceAccountToken, type TokenBundle } from "../../packages/litellm/provider-auth";
import { registerProviderOAuth } from "./provider-oauth";
import { registerCodexDevice } from "./codex-device";
import { importCodexTokens } from "../../packages/litellm/codex-auth";
import { attachGoogleProject, importSubscription } from "../../packages/litellm/subscription-auth";
import { googleSubscription, subscriptionRelay } from "../../packages/contracts/providers";

const key = z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const modelId = z.string().trim().min(1).max(256).optional();
const filename = z.string().trim().max(200).regex(/^[^/\\\x00-\x1f\x7f]+\.json$/i).optional();
const credential = z.union([z.object({ apiKey: key, modelId, filename }), z.object({ api_key: key, modelId, filename })]);

export function registerSourceCredentials(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv, auth: Auth) {
  async function sourceFor(id: string) {
    const [source] = await db`select * from sources where id = ${id}`;
    if (!source) throw new ApiError(404, "source_not_found", "Source not found");
    if (source.kind === "cpa") throw new ApiError(422, "direct_source_required", "Select a direct provider source for this credential");
    return source;
  }
  async function check(source: Awaited<ReturnType<typeof sourceFor>>, apiKey: string, requestedModel?: string, bundle?: TokenBundle) {
    if (requestedModel) {
      const [model] = await db`select reported, capability_override from source_models
        where source_id = ${source.id} and raw_model_id = ${requestedModel} and status = 'listed'`;
      const metadata = { ...model?.reported, ...model?.capability_override };
      const apiBase = metadata.apiBase ?? source.api_base;
      if (new URL(apiBase).origin !== new URL(source.api_base).origin) {
        throw new ApiError(422, "credential_origin_mismatch", "Choose a test model on the source inference origin");
      }
      const { verification } = await verifyModel({ modelId: requestedModel, apiBase, kind: source.kind,
        endpoint: metadata.upstreamEndpoint ?? source.default_endpoint }, apiKey, undefined, bundle);
      if (verification.code) throw new ApiError(422, verification.code,
        upstreamDescription(verification.code) ?? "The source rejected the credential test");
      return;
    }
    if (!source.directory_enabled) throw new ApiError(422, "credential_test_model_required", "Enter a model ID to test this credential");
    try { await readCatalog(source, env, apiKey, bundle); }
    catch (error) {
      const failure = catalogFailure(error);
      throw new ApiError(422, failure.code, "The credential could not be verified against the model directory"
        + (failure.status ? ` (HTTP ${failure.status})` : ""));
    }
  }
  async function replace(source: Awaited<ReturnType<typeof sourceFor>>, next: {
    id: string; sealed: string; filename?: string; type?: string; bundle?: TokenBundle;
  } | null, disable = false) {
    return db.begin(async (tx) => {
      const [current] = await tx`select revision from sources where id = ${source.id} for update`;
      if (current?.revision !== source.revision) throw new ApiError(409, "stale_source", "Source changed during validation");
      let accountId: string | null = null;
      let oldCredential: string | null = null;
      if (next) {
        const origins = [...new Set([new URL(source.directory_url).origin, new URL(source.api_base).origin])];
        await tx`insert into source_credentials (id, source_id, sealed_key, origins, filename, auth_type, expires_at, refresh_at) values
          (${next.id}, ${source.id}, ${next.sealed}, array(select jsonb_array_elements_text(${JSON.stringify(origins)}::text::jsonb)),
            ${next.filename ?? null}, ${next.type ?? "api_key"}, ${next.bundle ? new Date(next.bundle.expiresAt) : null},
            ${next.bundle ? next.bundle.refreshToken || next.bundle.account ? refreshDate(next.bundle.expiresAt)
              : new Date(next.bundle.expiresAt) : null})`;
        const [account] = await tx`select id, credential_id from subscription_accounts
          where id = ${source.account_id} and owner_source_id = ${source.id} for update`;
        if (account) {
          accountId = account.id;
          oldCredential = account.credential_id;
          const linked = await tx`select api_base, directory_url, directory_enabled from sources
            where account_id = ${accountId} and id <> ${source.id}`;
          if (linked.some((entry) => !origins.includes(new URL(entry.api_base).origin)
            || (entry.directory_enabled && !origins.includes(new URL(entry.directory_url).origin)))) {
            throw new ApiError(409, "account_origin_changed", "Linked sources require the existing account API origins");
          }
          await tx`update subscription_accounts set credential_id = ${next.id} where id = ${accountId}`;
          await tx`insert into source_credential_grants (source_id, credential_id)
            select id, ${next.id} from sources where account_id = ${accountId} on conflict do nothing`;
          await tx`update sources set credential_id = ${next.id}, revision = revision + 1,
            lease_token = null, lease_until = null, sync_state = 'pending', next_sync_at = now()
            where account_id = ${accountId} and id <> ${source.id}`;
          await tx`update source_models set verification = null where verification is not null and
            source_id in (select id from sources where account_id = ${accountId})`;
        } else {
          const [created] = await tx`insert into subscription_accounts (owner_source_id, credential_id)
            values (${source.id}, ${next.id}) returning id`;
          accountId = created.id;
        }
      }
      const [updated] = await tx`update sources set credential_id = ${next?.id ?? null}, account_id = ${accountId}, revision = revision + 1,
        enabled = enabled and not ${disable}, lease_token = null, lease_until = null, sync_state = 'pending', next_sync_at = now()
        where id = ${source.id} returning revision`;
      if (oldCredential) {
        await tx`update source_credentials set superseded_at = now() where id = ${oldCredential}`;
      }
      await tx`update source_models set verification = null where source_id = ${source.id} and verification is not null`;
      await tx`update features set reconcile_needed = true where approved_policy is not null`;
      return updated;
    });
  }
  async function attachToken(source: Awaited<ReturnType<typeof sourceFor>>, bundle: TokenBundle,
    type: string, filename?: string) {
    const cipher = credentialCipher(env);
    if (!cipher) throw new ApiError(503, "credential_storage_unavailable", "Credential encryption is unavailable");
    const id = crypto.randomUUID();
    return replace(source, { id, sealed: cipher.seal(JSON.stringify(bundle), `source-credential:${id}`), filename, type, bundle });
  }
  const installAuthorized = async (id: string, revision: number, bundle: TokenBundle, type: string) => {
    const source = await sourceFor(id);
    if (source.revision !== revision) throw new ApiError(409, "stale_source", "Source changed during authorization");
    if (googleSubscription(source.kind)) bundle = await attachGoogleProject(source.kind, source.slug, env, bundle);
    await attachToken(source, bundle, type);
  };
  registerProviderOAuth(app, db, env, auth, installAuthorized);
  registerCodexDevice(app, db, env, auth, installAuthorized);
  app.get("/admin/v1/subscription-accounts", async (_request, reply) => {
    const rows = await db`select a.id, s.slug as label, s.kind as provider, c.auth_type as "authType",
      c.filename, c.expires_at as "expiresAt", c.refresh_error as "refreshError",
      (select array_agg(link.slug order by link.slug) from sources link where link.account_id = a.id) as sources
      from subscription_accounts a join sources s on s.id = a.owner_source_id
      join source_credentials c on c.id = a.credential_id order by s.slug, a.id`;
    return reply.header("Cache-Control", "no-store").send(rows);
  });
  app.delete("/admin/v1/subscription-accounts/:id", async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    await db.begin(async (tx) => {
      const [account] = await tx`select credential_id from subscription_accounts where id = ${id} for update`;
      if (!account) return;
      const [linked] = await tx`select id from sources where account_id = ${id} limit 1`;
      if (linked) throw new ApiError(409, "account_in_use", "Unlink this account from its model sources before removing it");
      await tx`delete from subscription_accounts where id = ${id}`;
      await tx`update source_credentials set superseded_at = now() where id = ${account.credential_id}`;
    });
    return reply.code(204).send();
  });
  app.put("/admin/v1/sources/:id/subscription-account", async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { accountId } = z.strictObject({ accountId: uuid }).parse(request.body);
    return db.begin(async (tx) => {
      const [source] = await tx`select kind, api_base, directory_url, directory_enabled from sources where id = ${id} for update`;
      if (!source) throw new ApiError(404, "source_not_found", "Source not found");
      const [account] = await tx`select c.id, c.origins, s.kind
        from subscription_accounts a join source_credentials c on c.id = a.credential_id
        join sources s on s.id = a.owner_source_id where a.id = ${accountId} for update of a`;
      if (!account || account.kind !== source.kind || !account.origins.includes(new URL(source.api_base).origin)
        || (source.directory_enabled && !account.origins.includes(new URL(source.directory_url).origin))) {
        throw new ApiError(422, "account_incompatible", "Use an account for the same provider and API origins");
      }
      await tx`insert into source_credential_grants values (${id}, ${account.id}) on conflict do nothing`;
      await tx`update sources set credential_id = ${account.id}, account_id = ${accountId}, revision = revision + 1,
        lease_token = null, lease_until = null, sync_state = 'pending', next_sync_at = now() where id = ${id}`;
      await tx`update source_models set verification = null where source_id = ${id} and verification is not null`;
      await tx`update features set reconcile_needed = true where approved_policy is not null`;
      return { accountId };
    });
  });
  app.get("/admin/v1/authentication-files", async (_request, reply) => {
    const rows = await db`select s.id as "sourceId", s.slug as source, s.kind as provider, s.enabled,
      coalesce(c.filename, s.slug || '.json') as filename, c.imported_at as "importedAt", c.auth_type as "authType"
      from sources s join source_credentials c on c.id = s.credential_id where s.kind <> 'cpa' order by s.slug`;
    return reply.header("Cache-Control", "no-store").send(rows);
  });
  app.patch("/admin/v1/sources/:id/credential/status", async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(request.body);
    return db.begin(async (tx) => {
      const [updated] = await tx`update sources set enabled = ${enabled}, revision = revision + 1,
        lease_token = null, lease_until = null, sync_state = 'pending', next_sync_at = now()
        where id = ${id} and kind <> 'cpa' and credential_id is not null returning enabled`;
      if (!updated) throw new ApiError(404, "credential_not_found", "No imported credential for this source");
      await tx`update features set reconcile_needed = true where approved_policy is not null`;
      return updated;
    });
  });
  app.get("/admin/v1/sources/:id/credential/file", async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const [file] = await db`select c.id, c.sealed_key from sources s join source_credentials c on c.id = s.credential_id
      where s.id = ${id} and s.kind <> 'cpa' and c.auth_type = 'api_key'`;
    if (!file) throw new ApiError(404, "credential_not_found", "No imported credential for this source");
    let apiKey: string;
    try {
      const cipher = credentialCipher(env);
      if (!cipher) throw new Error();
      apiKey = cipher.open(file.sealed_key, `source-credential:${file.id}`);
    } catch {
      throw new ApiError(503, "credential_storage_unavailable", "The credential could not be decrypted");
    }
    await db`insert into admin_events (actor, action, entity_id) values ('admin', 'source.credential_downloaded', ${id})`;
    return reply.header("Cache-Control", "no-store")
      .header("Content-Disposition", 'attachment; filename="credential.json"').send({ apiKey });
  });
  app.put("/admin/v1/sources/:id/credential", async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const cipher = credentialCipher(env);
    if (!cipher) throw new ApiError(503, "credential_storage_unavailable", "Configure MINATO_CREDENTIAL_SECRET or MINATO_AUDIT_SECRET");
    const parsed = credential.safeParse(request.body);
    const source = await sourceFor(id);
    if (subscriptionRelay(source.kind)) {
      const { filename: importedFile, modelId: probe } = z.object({ filename, modelId }).parse(request.body);
      let bundle: TokenBundle;
      try { bundle = await importSubscription(source.kind, source.slug, env, request.body); }
      catch (error) {
        if (error instanceof Error && error.message === "google_project_unavailable") {
          throw new ApiError(422, "google_project_unavailable", "The Google account has no Code Assist project. Set the source project or import credentials with project_id.");
        }
        throw new ApiError(422, "invalid_subscription_credential", "Use a valid provider authentication JSON with a current or refreshable token");
      }
      if (probe || source.directory_enabled) await check(source, bundle.accessToken, probe, bundle);
      return reply.header("Cache-Control", "no-store").send(await attachToken(source, bundle, "oauth", importedFile));
    }
    if (source.kind === "codex") {
      if (env.MINATO_DATA_PLANE !== "runtime") throw new ApiError(422, "codex_runtime_required", "Use the Go Runtime for Codex");
      const { filename: importedFile, modelId: probe } = z.object({ filename, modelId }).parse(request.body);
      let bundle: TokenBundle;
      try { bundle = await importCodexTokens(request.body); }
      catch { throw new ApiError(422, "invalid_codex_credential", "Use a Codex or CPA Codex login JSON with refresh credentials"); }
      if (source.directory_enabled || probe) await check(source, bundle.accessToken, probe);
      return reply.header("Cache-Control", "no-store").send(await attachToken(source, bundle, "oauth", importedFile));
    }
    if (source.kind === "vertex") {
      const input = serviceAccount.extend({ filename, modelId }).safeParse(request.body);
      if (!input.success) throw new ApiError(422, "invalid_service_account", "Import a Google Cloud service account JSON file");
      const { filename: importedFile, modelId: probe, ...account } = input.data;
      const base = new URL(source.api_base);
      const directory = new URL(source.directory_url);
      if (base.protocol !== "https:" || !/^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(base.hostname)
        || (source.directory_enabled && directory.origin !== base.origin)) {
        throw new ApiError(422, "invalid_vertex_origin", "Use an official Vertex AI endpoint");
      }
      let bundle: TokenBundle;
      try { bundle = await serviceAccountToken(account); }
      catch { throw new ApiError(422, "service_account_rejected", "Google could not validate the service account"); }
      await check(source, bundle.accessToken, probe);
      return reply.header("Cache-Control", "no-store").send(await attachToken(source, bundle, "service_account", importedFile));
    }
    if (!parsed.success) throw new ApiError(422, "invalid_credential_file", "Use a JSON object with an apiKey or api_key field");
    const apiKey = "apiKey" in parsed.data ? parsed.data.apiKey : parsed.data.api_key;
    await check(source, apiKey, parsed.data.modelId);
    const credentialId = crypto.randomUUID();
    const result = await replace(source, { id: credentialId, sealed: cipher.seal(apiKey, `source-credential:${credentialId}`),
      filename: parsed.data.filename });
    return reply.header("Cache-Control", "no-store").send(result);
  });
  app.delete("/admin/v1/sources/:id/credential", async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { disable, modelId: probe } = z.strictObject({ disable: z.boolean().default(false), modelId }).parse(request.body ?? {});
    const source = await sourceFor(id);
    if (!source.credential_id) return reply.code(204).send();
    if (!disable) {
      const fallback = source.credential_env && env[source.credential_env];
      if (!fallback) throw new ApiError(422, "environment_credential_missing", "Configure an environment credential or disable the source");
      await check(source, fallback, probe);
    }
    await replace(source, null, disable);
    return reply.code(204).send();
  });
}
