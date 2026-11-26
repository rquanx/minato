import { auditCipher, contentCipher } from "./audit";
import type { connectDatabase } from "./client";
import { oauthExchange, refreshDate, serviceAccountToken, TokenError, type TokenBundle } from "../litellm/provider-auth";
import { codexOAuth } from "../litellm/codex-auth";
import { refreshKimi, subscriptionOAuth } from "../litellm/subscription-auth";

export function credentialCipher(env: NodeJS.ProcessEnv) {
  const secret = env.MINATO_CREDENTIAL_SECRET;
  return secret === undefined ? auditCipher(env) : secret.length >= 32 ? contentCipher(secret) : undefined;
}

export function sourceCredentials(db: ReturnType<typeof connectDatabase>, env: NodeJS.ProcessEnv) {
  const read = readSourceCredential(db, env);
  return async (source: string, id: string, target: string) => (await read(source, id, target)).accessToken;
}

export function readSourceCredential(db: ReturnType<typeof connectDatabase>, env: NodeJS.ProcessEnv) {
  const cipher = credentialCipher(env);
  return async (source: string, id: string, target: string, kind?: string) => {
    if (!cipher) throw new Error("upstream_credential_missing");
    const [entry] = await db`select c.sealed_key, c.origins, c.auth_type, c.expires_at
      from source_credentials c join sources s on s.slug = ${source}
      where c.id = ${id} and (${kind ?? null}::text is null or s.kind = ${kind ?? null})
      and (c.source_id = s.id or exists (
        select 1 from source_credential_grants g where g.source_id = s.id and g.credential_id = c.id))`;
    if (!entry) throw new Error("upstream_credential_missing");
    if (!entry.origins.includes(new URL(target).origin)) throw new Error("upstream_credential_origin_mismatch");
    if (entry.expires_at && new Date(entry.expires_at).getTime() <= Date.now()) throw new Error("upstream_credential_expired");
    try {
      const value = cipher.open(entry.sealed_key, `source-credential:${id}`);
      return entry.auth_type === "api_key" ? { accessToken: value } : JSON.parse(value) as TokenBundle;
    }
    catch { throw new Error("upstream_credential_unreadable"); }
  };
}

export async function refreshSourceCredential(db: ReturnType<typeof connectDatabase>, env: NodeJS.ProcessEnv) {
  const cipher = credentialCipher(env);
  if (!cipher) return false;
  return db.begin(async (tx) => {
    const [entry] = await tx`select c.id, c.sealed_key, c.auth_type, c.expires_at, s.slug, s.kind
      from source_credentials c join subscription_accounts a on a.credential_id = c.id
      join sources s on s.id = a.owner_source_id
      where c.refresh_at <= now() and exists (select 1 from sources active where active.account_id = a.id and active.enabled)
      order by c.refresh_at limit 1 for update of s, c skip locked`;
    if (!entry) return false;
    let next: TokenBundle;
    try {
      const current = JSON.parse(cipher.open(entry.sealed_key, `source-credential:${entry.id}`)) as TokenBundle;
      if (entry.auth_type === "service_account" && current.account) {
        next = await serviceAccountToken(current.account);
      } else if (entry.kind === "kimi" && current.refreshToken && current.deviceId) {
        next = await refreshKimi(current);
      } else {
        const config = entry.kind === "codex" ? codexOAuth : subscriptionOAuth(entry.kind, entry.slug, env);
        if (!config || !current.refreshToken || config.tokenUrl !== current.tokenUrl || config.clientId !== current.clientId) {
          throw new TokenError(true);
        }
        next = await oauthExchange(config, { grant_type: "refresh_token", refresh_token: current.refreshToken });
        next.refreshToken ??= current.refreshToken;
        next.projectId = current.projectId;
      }
    } catch (error) {
      const reauthorize = error instanceof TokenError && error.permanent;
      await tx`update source_credentials set refresh_error = ${reauthorize ? "reauthorization_required" : "token_endpoint_unavailable"},
        refresh_at = ${reauthorize ? null : new Date(Date.now() + 60_000)} where id = ${entry.id}`;
      if (reauthorize || new Date(entry.expires_at).getTime() <= Date.now()) {
        await tx`update features set reconcile_needed = true where approved_policy is not null`;
      }
      return true;
    }
    await tx`update source_credentials set sealed_key = ${cipher.seal(JSON.stringify(next), `source-credential:${entry.id}`)},
      expires_at = ${new Date(next.expiresAt)}, refresh_at = ${refreshDate(next.expiresAt)},
      token_version = token_version + 1, refresh_error = null where id = ${entry.id}`;
    await tx`update features set reconcile_needed = true where approved_policy is not null`;
    return true;
  });
}

export async function cleanSupersededCredentials(db: ReturnType<typeof connectDatabase>) {
  await db`delete from source_credentials c where c.id in (
    select old.id from source_credentials old
    where old.superseded_at < now() - interval '24 hours'
      and not exists (select 1 from sources s where s.credential_id = old.id)
      and not exists (select 1 from subscription_accounts a where a.credential_id = old.id)
      and not exists (select 1 from features f where coalesce(f.draft, '[]') @>
        jsonb_build_array(jsonb_build_object('credentialId', old.id::text)))
      and not exists (
        select 1 from route_versions r join features f on f.id = r.feature_id
        where r.candidates @> jsonb_build_array(jsonb_build_object('credentialId', old.id::text))
          and (r.approved_policy is null or r.state in ('queued', 'preparing')
            or r.version in (f.active_version, f.desired_version))
      )
    order by old.superseded_at limit 100 for update of old skip locked
  )`;
}
