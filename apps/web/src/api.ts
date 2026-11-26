import type { ProviderKind } from "../../../packages/contracts/providers";

export type Project = { id: string; slug: string; displayName: string };
export type Environment = Project;
export type Feature = {
  id: string; alias: string; slug: string; draftRevision: number;
  activeRouteVersion: string | null; desiredRouteVersion: string | null;
  unavailable?: boolean; routeReason?: string; desiredRouteState?: string; activeModels?: ModelRef[];
  routingPolicy?: { primary?: ModelRef; fallbacks?: ModelRef[]; orderedModels?: ModelRef[]; useRegistrationPreference?: boolean };
  declaration: { displayName: string; preferredModel?: ModelRef; requirements: { endpoint: string } };
};
export type ModelRef = { sourceId: string; modelId: string };
export type Source = {
  id: string; slug: string; kind: ProviderKind; enabled: boolean; syncState: string;
  directoryUrl: string; apiBase: string; defaultEndpoint: string; credentialEnv: string | null; revision: number;
  lastSuccessAt: string | null;
  cpaManagement?: boolean;
  managedCredential?: boolean;
  directoryEnabled?: boolean;
  oauthAvailable?: boolean;
  credentialType?: "api_key" | "oauth" | "service_account" | null;
  credentialExpiresAt?: string | null;
  credentialError?: string | null;
  accountId?: string | null;
};
export type Call = {
  requestId: string; alias: string; kind: string; status: string; captureState: string;
  startedAt: string; durationMs: number | null; totalTokens: string | null;
  correlationId: string | null; endpoint: string; httpStatus: number | null;
  attemptCount: number; modelId: string | null; sourceId: string | null;
};

let csrf = "";
export let memberSession = false;
export async function api<T>(path: string, method = "GET", body?: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await fetch("/admin/v1" + path, {
    method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export async function session() {
  const response = await fetch("/admin/v1/session");
  if (response.status === 401) return false;
  if (!response.ok) throw new Error("Could not check the session");
  const current = await response.json();
  csrf = current.csrfToken;
  memberSession = current.memberId !== null;
  return true;
}
export const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "";
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
