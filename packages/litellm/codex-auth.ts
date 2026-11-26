import { z } from "zod";
import { oauthExchange, type TokenBundle } from "./provider-auth";

const issuer = "https://auth.openai.com";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const redirect = issuer + "/deviceauth/callback";
export const codexLoginUrl = issuer + "/codex/device";
export const codexBase = "https://chatgpt.com/backend-api/codex";
export const codexCallback = "http://localhost:1455/auth/callback";
export const codexOAuth = { authorizationUrl: codexLoginUrl, tokenUrl: issuer + "/oauth/token", clientId, scope: "" };
export const codexBrowserOAuth = { ...codexOAuth, authorizationUrl: issuer + "/oauth/authorize",
  scope: "openid profile email offline_access" };

function claims(token: string) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<string, any>; }
  catch { return {}; }
}

export function codexHeaders(token: string) {
  const account = claims(token)["https://api.openai.com/auth"]?.chatgpt_account_id;
  return {
    authorization: `Bearer ${token}`, originator: "codex_cli_rs",
    ...(typeof account === "string" && /^[\w-]{1,128}$/.test(account) ? { "chatgpt-account-id": account } : {}),
  };
}

const importTokens = z.object({ access_token: z.string().regex(/^[\x21-\x7e]+$/).max(32768),
  refresh_token: z.string().regex(/^[\x21-\x7e]+$/).max(32768) });
export async function importCodexTokens(raw: unknown): Promise<TokenBundle> {
  const file = z.union([z.object({ tokens: importTokens }).transform(({ tokens }) => tokens), importTokens]).parse(raw);
  const expiresAt = Number(claims(file.access_token).exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
    const renewed = await oauthExchange(codexOAuth, { grant_type: "refresh_token", refresh_token: file.refresh_token });
    return { ...renewed, refreshToken: renewed.refreshToken ?? file.refresh_token };
  }
  return { accessToken: file.access_token, refreshToken: file.refresh_token, expiresAt,
    tokenUrl: codexOAuth.tokenUrl, clientId };
}

function deviceRequest(path: string, payload: object) {
  return fetch(issuer + "/api/accounts/deviceauth/" + path, {
    method: "POST", body: JSON.stringify(payload), redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
}

export async function beginCodexLogin() {
  const response = await deviceRequest("usercode", { client_id: clientId });
  if (!response.ok) { await response.body?.cancel(); throw new Error("codex_device_unavailable"); }
  const data = z.object({ device_auth_id: z.string().min(1), user_code: z.string().optional(),
    usercode: z.string().optional(), interval: z.coerce.number().optional() }).parse(await response.json());
  const userCode = data.user_code ?? data.usercode;
  if (!userCode) throw new Error("codex_device_unavailable");
  return { deviceId: data.device_auth_id, userCode, interval: Math.max(5, Math.min(data.interval ?? 5, 60)) };
}

export async function pollCodexLogin(deviceId: string, userCode: string) {
  const response = await deviceRequest("token", { device_auth_id: deviceId, user_code: userCode });
  if (response.status === 403 || response.status === 404) { await response.body?.cancel(); return; }
  if (!response.ok) { await response.body?.cancel(); throw new Error("codex_device_poll_failed"); }
  const data = z.object({ authorization_code: z.string().min(1), code_verifier: z.string().min(1) }).parse(await response.json());
  return oauthExchange(codexOAuth, { grant_type: "authorization_code", code: data.authorization_code,
    redirect_uri: redirect, code_verifier: data.code_verifier });
}
