import type { Candidate } from "../litellm/client";

export function runtimeRouteKey(featureId: string, version: string) {
  return `minato-${featureId}-${version}`;
}

export function runtimeConfig(env = process.env) {
  if (!env.MINATO_RUNTIME_BASE_URL) throw new Error("MINATO_RUNTIME_BASE_URL is required");
  const base = new URL(env.MINATO_RUNTIME_BASE_URL);
  const token = env.MINATO_RUNTIME_TOKEN;
  if (!token) throw new Error("MINATO_RUNTIME_TOKEN is required");
  return { base, headers: { authorization: `Bearer ${token}` } };
}

export function createRuntime(env = process.env) {
  const { base, headers } = runtimeConfig(env);
  async function request(path: string, init: RequestInit = {}) {
    return fetch(new URL(path, base), {
      ...init,
      headers: { ...headers, "content-type": "application/json", ...init.headers },
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      redirect: "error",
    });
  }
  function serialize(entry: Candidate) {
    if (!env[entry.credentialEnv]) throw new Error("upstream_credential_missing");
    return { sourceId: entry.sourceId, modelId: entry.modelId, apiBase: entry.apiBase,
      credentialRef: entry.credentialEnv, endpoint: entry.upstreamEndpoint };
  }
  async function publish(alias: string, version: string, deployments: Candidate[], signal?: AbortSignal) {
    const response = await request(`/internal/v1/routes/${encodeURIComponent(alias)}`, {
      method: "PUT",
      signal,
      body: JSON.stringify({ alias, version, candidates: deployments.map(serialize) }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("runtime_route_publish_failed");
  }
  return {
    async stage(group: string, deployment: Candidate) {
      await publish(group, "1", [deployment]);
    },
    publish,
  };
}

