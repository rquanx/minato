import { z } from "zod";
import { browserSubscription, googleSubscription, providerUrls, type ProviderKind } from "../contracts/providers";
import { oauthConfig, oauthExchange, googleTokenUrl, parseToken, type OAuthConfig, type TokenBundle } from "./provider-auth";

export const browserCallbacks = {
  claude: "http://localhost:54545/callback",
  "gemini-cli": "http://localhost:8085/oauth2callback",
  antigravity: "http://localhost:51121/oauth-callback",
} as const;
export const googleSubscriptionScope = "https://www.googleapis.com/auth/cloud-platform";
const googleScope = googleSubscriptionScope + " https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

export function subscriptionOAuth(kind: string, slug: string, env: NodeJS.ProcessEnv): OAuthConfig | undefined {
  if (!browserSubscription(kind)) return kind === "openai" ? oauthConfig(slug, env) : undefined;
  const prefix = "MINATO_OAUTH_" + kind.toUpperCase().replaceAll("-", "_") + "_";
  const clientId = env[prefix + "CLIENT_ID"];
  if (!clientId) return;
  const clientSecret = env[prefix + "CLIENT_SECRET"];
  if (kind === "claude") return { clientId, clientSecret, json: true, authorizationUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token", scope: "user:profile user:inference user:sessions:claude_code" };
  if (!clientSecret) return;
  return { clientId, clientSecret, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: googleTokenUrl,
    scope: googleScope + (kind === "antigravity" ? " https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs" : "") };
}

const kimiIssuer = "https://auth.kimi.com";
const kimiOAuth = {
  clientId: "17e5f671-d194-4dfb-9706-5516cb48c098", authorizationUrl: kimiIssuer,
  tokenUrl: kimiIssuer + "/api/oauth/token", scope: "",
};
export function kimiHeaders(deviceId: string) {
  return { "x-msh-device-id": deviceId, "x-msh-platform": "kimi_cli",
    "x-msh-version": "1.10.6", "x-msh-device-name": "Minato", "x-msh-device-model": process.platform };
}
export async function beginKimiLogin() {
  const deviceId = crypto.randomUUID();
  const result = await fetch(kimiIssuer + "/api/oauth/device_authorization", {
    method: "POST", body: new URLSearchParams({ client_id: kimiOAuth.clientId }), redirect: "error",
    headers: { ...kimiHeaders(deviceId), accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) { await result.body?.cancel(); throw new Error("device_flow_failed"); }
  const flow = z.object({
    device_code: z.string().min(1), user_code: z.string().min(1), verification_uri: z.string().optional(),
    verification_uri_complete: z.string().optional(), interval: z.coerce.number().int().optional(), expires_in: z.coerce.number().int().positive(),
  }).parse(await result.json());
  const verification = flow.verification_uri_complete || flow.verification_uri;
  if (!verification) throw new Error("invalid_device_url");
  const verificationUrl = new URL(verification);
  if (verificationUrl.protocol !== "https:" || !["auth.kimi.com", "kimi.com", "www.kimi.com"].includes(verificationUrl.hostname)
    || verificationUrl.username || verificationUrl.password) throw new Error("invalid_device_url");
  return { deviceId, deviceCode: flow.device_code, userCode: flow.user_code, verificationUrl: verificationUrl.href,
    interval: Math.max(5, Math.min(flow.interval ?? 5, 60)), expiresIn: Math.min(flow.expires_in, 900) };
}
export async function pollKimiLogin(flow: { deviceId: string; deviceCode: string }) {
  const result = await fetch(kimiOAuth.tokenUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { ...kimiHeaders(flow.deviceId), accept: "application/json" }, body: new URLSearchParams({ client_id: kimiOAuth.clientId,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: flow.deviceCode }) });
  const raw = await result.json().catch(() => null);
  if (raw?.error === "authorization_pending") return { status: "pending" as const };
  if (raw?.error === "slow_down") return { status: "slow_down" as const };
  if (raw?.error === "access_denied" || raw?.error === "expired_token") return { status: "expired" as const };
  const tokens = parseToken(raw, result.status);
  return { status: "connected" as const, tokens: { ...tokens, deviceId: flow.deviceId,
    clientId: kimiOAuth.clientId, tokenUrl: kimiOAuth.tokenUrl } };
}
export async function refreshKimi(current: TokenBundle) {
  if (!current.deviceId || !current.refreshToken) throw new Error("kimi_credentials_missing");
  const token = await oauthExchange(kimiOAuth, { grant_type: "refresh_token", refresh_token: current.refreshToken }, kimiHeaders(current.deviceId));
  return { ...token, deviceId: current.deviceId, refreshToken: token.refreshToken ?? current.refreshToken };
}

const cloudMetadata = (kind: string) => ({
  ideType: kind === "antigravity" ? "ANTIGRAVITY" : "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI",
});

function cloudProject(value: unknown) {
  const id = typeof value === "object" && value && "id" in value ? value.id : value;
  return typeof id === "string" ? id.trim() : "";
}

const codeAssistResponse = z.object({
  cloudaicompanionProject: z.unknown().optional(),
  allowedTiers: z.array(z.object({ id: z.string().optional(), isDefault: z.boolean().optional() })).optional(),
  done: z.boolean().optional(),
  response: z.object({ cloudaicompanionProject: z.unknown().optional() }).optional(),
});

export async function attachGoogleProject(kind: string, slug: string, env: NodeJS.ProcessEnv, bundle: TokenBundle) {
  const explicit = env["MINATO_GOOGLE_PROJECT_" + slug.toUpperCase().replaceAll("-", "_")]?.trim();
  if (explicit || bundle.projectId) return { ...bundle, projectId: explicit || bundle.projectId };
  const base = providerUrls[kind as ProviderKind]!.base;
  const metadata = cloudMetadata(kind);
  const deadline = AbortSignal.timeout(25_000);
  const call = async (action: "loadCodeAssist" | "onboardUser", body: object) => {
    const response = await fetch(base + "/v1internal:" + action, {
      method: "POST", redirect: "error", signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      headers: { authorization: "Bearer " + bundle.accessToken, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    const data = codeAssistResponse.safeParse(await response?.json().catch(() => null));
    if (!response?.ok || !data.success) throw new Error("google_project_unavailable");
    return data.data;
  };
  const loaded = await call("loadCodeAssist", { metadata });
  const existing = cloudProject(loaded.cloudaicompanionProject);
  if (existing) return { ...bundle, projectId: existing };

  const tierId = loaded.allowedTiers?.find((tier) => tier.isDefault && tier.id?.trim())?.id ?? "legacy-tier";
  for (let attempt = 0; attempt < 5 && !deadline.aborted; attempt++) {
    if (attempt > 0) await Bun.sleep(2000);
    const operation = await call("onboardUser", { metadata, tierId });
    if (operation.done) {
      const projectId = cloudProject(operation.response?.cloudaicompanionProject);
      if (projectId) return { ...bundle, projectId };
      break;
    }
  }
  throw new Error("google_project_unavailable");
}

export function claudeHeaders(token: string) {
  return { authorization: "Bearer " + token, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" };
}

const fileToken = z.object({
  access_token: z.string().regex(/^[\x21-\x7e]+$/).max(32_768),
  refresh_token: z.string().min(1).max(32_768).optional(),
  expiry: z.string().optional(),
  expired: z.string().optional(),
  expire: z.string().optional(),
  expires_at: z.union([z.string(), z.number()]).optional(),
  timestamp: z.number().optional(),
  expires_in: z.number().positive().optional(),
});
export async function importSubscription(kind: string, slug: string, env: NodeJS.ProcessEnv, payload: unknown) {
  const source = z.object({ token: fileToken.optional(), project_id: z.string().optional(),
    device_id: z.string().regex(/^[\w-]{1,128}$/).optional() }).parse(payload);
  const token = source.token ?? fileToken.parse(payload);
  const expiration = token.expiry ?? token.expired ?? token.expire ?? token.expires_at
    ?? (token.timestamp && token.expires_in ? token.timestamp + token.expires_in * 1000 : undefined);
  const config = kind === "kimi" ? kimiOAuth : subscriptionOAuth(kind, slug, env);
  const expiresAt = typeof expiration === "number" ? (expiration < 1e12 ? expiration * 1000 : expiration)
    : Date.parse(expiration ?? "");
  let bundle: TokenBundle = { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt,
    projectId: source.project_id, deviceId: source.device_id, clientId: config?.clientId, tokenUrl: config?.tokenUrl };
  if (kind === "kimi" && !bundle.deviceId) throw new Error("kimi_device_unavailable");
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 1000) {
    if (!config || !bundle.refreshToken) throw new Error("subscription_token_expired");
    if (kind === "kimi") bundle = await refreshKimi(bundle);
    else {
      const refreshed = await oauthExchange(config, { grant_type: "refresh_token", refresh_token: bundle.refreshToken });
      bundle = { ...bundle, ...refreshed, refreshToken: refreshed.refreshToken ?? bundle.refreshToken };
    }
  }
  if (googleSubscription(kind)) bundle = await attachGoogleProject(kind, slug, env, bundle);
  return bundle;
}
