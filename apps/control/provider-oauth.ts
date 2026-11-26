import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, uuid } from "../../packages/contracts";
import { credentialCipher } from "../../packages/db/source-credentials";
import { oauthExchange, type TokenBundle } from "../../packages/litellm/provider-auth";
import { browserCallbacks, subscriptionOAuth } from "../../packages/litellm/subscription-auth";
import { browserSubscription, googleSubscription } from "../../packages/contracts/providers";
import type { Auth, Database } from "./auth";
import { codexBrowserOAuth, codexCallback } from "../../packages/litellm/codex-auth";

const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const landing = "/?view=sources";
const callbackPath = "/oauth/provider/callback";
const callback = z.object({ state: z.string().regex(/^[\w-]{43}$/), code: z.string().min(1).max(4096).optional(),
  error: z.string().max(128).optional() });

export function registerProviderOAuth(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv, auth: Auth,
  attach: (sourceId: string, revision: number, token: TokenBundle, verifier: string) => Promise<unknown>) {
  const cipher = credentialCipher(env);
  app.post("/admin/v1/sources/:id/oauth", async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const [source] = await db`select slug, kind, revision from sources where id = ${id}`;
    const codex = source?.kind === "codex" && env.MINATO_DATA_PLANE === "runtime";
    const config = codex ? codexBrowserOAuth : source && subscriptionOAuth(source.kind, source.slug, env);
    if (!config || !cipher) throw new ApiError(422, "oauth_not_configured", "Configure an OAuth client for this model source");
    if (browserSubscription(source.kind) && env.MINATO_DATA_PLANE !== "runtime") {
      throw new ApiError(422, "subscription_runtime_required", "Use the Go Runtime for this subscription");
    }
    const origin = new URL(env.MINATO_PUBLIC_ORIGIN ?? `${request.protocol}://${request.host}`);
    const fixedCallback = codex ? codexCallback : browserCallbacks[source.kind as keyof typeof browserCallbacks];
    if (!fixedCallback && origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
      throw new ApiError(422, "oauth_origin_requires_https", "Set MINATO_PUBLIC_ORIGIN to the HTTPS console address");
    }
    const redirect = fixedCallback ?? new URL(callbackPath, origin).href;
    const { reference } = await auth.admin(request);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    await db.begin(async (tx) => {
      await tx`delete from provider_oauth_sessions where expires_at < now()`;
      await tx`insert into provider_oauth_sessions (state_hash, source_id, source_revision, session_ref, verifier_sealed, redirect_uri)
        values (${hash(state)}, ${id}, ${source.revision}, ${reference}, ${cipher.seal(verifier, hash(state))}, ${redirect})`;
    });
    const authorization = new URL(config.authorizationUrl);
    for (const [name, value] of Object.entries({ client_id: config.clientId, redirect_uri: redirect, response_type: "code",
      state, code_challenge: hash(verifier), code_challenge_method: "S256", ...(config.scope ? { scope: config.scope } : {}) })) {
      authorization.searchParams.set(name, value);
    }
    if (codex) {
      authorization.searchParams.set("id_token_add_organizations", "true");
      authorization.searchParams.set("codex_cli_simplified_flow", "true");
    }
    if (googleSubscription(source.kind)) {
      authorization.searchParams.set("access_type", "offline");
      authorization.searchParams.set("prompt", "consent");
    }
    if (source.kind === "claude") authorization.searchParams.set("code", "true");
    return { authorizationUrl: authorization.href, state };
  });

  async function complete({ state, code, error }: z.infer<typeof callback>, uri: URL, session?: string, sourceId?: string) {
    if (!cipher || (!code && !error)) return { status: "invalid" };
    const stateHash = hash(state);
    const [flow] = await db`update provider_oauth_sessions f set status = 'consumed'
      from admin_sessions a, sources s where f.state_hash = ${stateHash} and f.status = 'pending' and f.expires_at > now()
      and a.digest = f.session_ref and a.member_id is null and a.expires_at > now()
      and s.id = f.source_id and s.revision = f.source_revision
      and f.redirect_uri = ${uri.origin + uri.pathname}
      and (${session ?? null}::text is null or f.session_ref = ${session ?? null})
      and (${sourceId ?? null}::uuid is null or f.source_id = ${sourceId ?? null})
      returning f.source_id, f.source_revision, f.verifier_sealed, f.redirect_uri, s.slug, s.kind`;
    if (!flow) return { status: "invalid" };
    const result = (status: string) => ({ status, source: flow.source_id });
    if (error || !code) {
      await db`update provider_oauth_sessions set status = 'cancelled' where state_hash = ${stateHash}`;
      return result("cancelled");
    }
    let status = "failed";
    try {
      const config = flow.kind === "codex" ? codexBrowserOAuth : subscriptionOAuth(flow.kind, flow.slug, env);
      if (!config) throw new Error();
      const verifier = cipher.open(flow.verifier_sealed, stateHash);
      // Claude can append the state to the authorization code.
      const authorizationCode = flow.kind === "claude" ? code.split("#", 1)[0] : code;
      if (!authorizationCode) throw new Error();
      const tokens = await oauthExchange(config, { grant_type: "authorization_code", code: authorizationCode,
        ...(flow.kind === "claude" ? { state } : {}),
        code_verifier: verifier, redirect_uri: flow.redirect_uri });
      await attach(flow.source_id, flow.source_revision, tokens, "oauth");
      status = "connected";
    } catch { /* The console receives a status without authorization or token data. */ }
    await db`update provider_oauth_sessions set status = ${status} where state_hash = ${stateHash}`;
    return result(status);
  }
  const loopbacks = [codexCallback, ...Object.values(browserCallbacks)].map((uri) => new URL(uri));
  for (const path of [callbackPath, ...loopbacks.map((uri) => uri.pathname)]) app.get(path, async (request, reply) => {
    const parsed = callback.safeParse(request.query);
    const uri = loopbacks.find((url) => url.pathname === path) ??
      new URL(path, env.MINATO_PUBLIC_ORIGIN ?? `${request.protocol}://${request.host}`);
    const { status, source } = parsed.success ? await complete(parsed.data, uri) : { status: "invalid", source: undefined };
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    if (path === "/auth/callback") {
      return reply.type("text/plain").send(status === "connected" ? "Codex connected. Return to the Minato console." :
        "Codex authorization was not completed. Return to the Minato console.");
    }
    if (path !== callbackPath) return reply.type("text/plain").send(status === "connected" ? "Provider connected. Return to Minato." :
      "Authorization could not be completed. Return to Minato.");
    return reply.redirect(`${landing}&oauth=${status}${source ? "&source=" + source : ""}`, 303);
  });
  app.post("/admin/v1/sources/:id/oauth/complete", async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { redirectUrl } = z.object({ redirectUrl: z.url().max(8192) }).parse(request.body);
    const uri = new URL(redirectUrl);
    const parsed = callback.safeParse(Object.fromEntries(uri.searchParams));
    const { reference } = await auth.admin(request);
    const claudeStateFragment = uri.origin + uri.pathname === browserCallbacks.claude &&
      parsed.success && uri.hash === "#" + parsed.data.state;
    const result = parsed.success && !uri.username && !uri.password && (!uri.hash || claudeStateFragment)
      ? await complete(parsed.data, uri, reference, id) : { status: "invalid" };
    if (result.status === "invalid") throw new ApiError(422, "invalid_oauth_callback", "Paste the callback URL from this authorization session");
    return reply.header("Cache-Control", "no-store").send(result);
  });
  app.get("/admin/v1/sources/:id/oauth/status", async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { state } = callback.pick({ state: true }).parse(request.query);
    const { reference } = await auth.admin(request);
    const [flow] = await db`select status from provider_oauth_sessions where state_hash = ${hash(state)}
      and source_id = ${id} and session_ref = ${reference} and expires_at > now()`;
    return reply.header("Cache-Control", "no-store").send({ status: flow?.status ?? "expired" });
  });
}
