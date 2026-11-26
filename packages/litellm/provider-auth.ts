import { createSign } from "node:crypto";
import { z } from "zod";

export const googleTokenUrl = "https://oauth2.googleapis.com/token";
export const serviceAccount = z.object({
  type: z.literal("service_account"), client_email: z.email(),
  private_key: z.string().min(100).max(8192), project_id: z.string().optional(),
});
export type ServiceAccount = z.infer<typeof serviceAccount>;
export type TokenBundle = { accessToken: string; refreshToken?: string; expiresAt: number; account?: ServiceAccount;
  tokenUrl?: string; clientId?: string; projectId?: string; deviceId?: string };
export type OAuthConfig = { authorizationUrl: string; tokenUrl: string; clientId: string; clientSecret?: string; scope: string;
  json?: boolean };

function secureUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("invalid_oauth_configuration");
  }
  return url.href;
}

export function oauthConfig(slug: string, env: NodeJS.ProcessEnv): OAuthConfig | undefined {
  const prefix = "MINATO_OAUTH_" + slug.toUpperCase().replaceAll("-", "_") + "_";
  const authorizationUrl = env[prefix + "AUTHORIZATION_URL"];
  const tokenUrl = env[prefix + "TOKEN_URL"];
  const clientId = env[prefix + "CLIENT_ID"];
  if (!authorizationUrl || !tokenUrl || !clientId) return;
  return { authorizationUrl: secureUrl(authorizationUrl), tokenUrl: secureUrl(tokenUrl), clientId,
    clientSecret: env[prefix + "CLIENT_SECRET"], scope: env[prefix + "SCOPE"] ?? "" };
}

export class TokenError extends Error {
  constructor(readonly permanent: boolean) { super(permanent ? "reauthorization_required" : "token_endpoint_unavailable"); }
}
const tokenResponse = z.object({
  access_token: z.string().min(1).max(32_768).regex(/^[\x21-\x7e]+$/),
  refresh_token: z.string().min(1).max(32_768).optional(),
  expires_in: z.coerce.number().int().positive().max(31_536_000),
  token_type: z.string().optional(),
});

export function parseToken(raw: any, status: number): TokenBundle {
  if (status < 200 || status >= 300 || raw?.error) {
    throw new TokenError(status === 401 || status === 403 || (status < 500 &&
      ["invalid_grant", "invalid_client", "unauthorized_client"].includes(raw?.error)));
  }
  const token = tokenResponse.safeParse(raw);
  if (!token.success || (token.data.token_type && token.data.token_type.toLowerCase() !== "bearer")) throw new TokenError(false);
  return { accessToken: token.data.access_token, refreshToken: token.data.refresh_token,
    expiresAt: Date.now() + token.data.expires_in * 1000 };
}

async function exchange(url: string, fields: Record<string, string>, json = false, headers: Record<string, string> = {}): Promise<TokenBundle> {
  const response = await fetch(url, { method: "POST", body: json ? JSON.stringify(fields) : new URLSearchParams(fields), redirect: "error",
    signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", ...headers,
      ...(json ? { "content-type": "application/json" } : {}) } }).catch(() => { throw new TokenError(false); });
  return parseToken(await response.json().catch(() => null), response.status);
}

export async function oauthExchange(config: OAuthConfig, fields: Record<string, string>, headers?: Record<string, string>) {
  const token = await exchange(config.tokenUrl, { ...fields, client_id: config.clientId,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) }, config.json, headers);
  return { ...token, tokenUrl: config.tokenUrl, clientId: config.clientId };
}

export async function serviceAccountToken(account: ServiceAccount, tokenUrl = googleTokenUrl) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
    iss: account.client_email, aud: tokenUrl, iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/cloud-platform",
  });
  const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url");
  const token = await exchange(tokenUrl, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + signature });
  return { ...token, account };
}

export function refreshDate(expiresAt: number) {
  const remaining = expiresAt - Date.now();
  return new Date(expiresAt - Math.min(300_000, Math.max(1_000, remaining / 5)));
}
