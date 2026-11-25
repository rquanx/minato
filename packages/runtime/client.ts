import type { Candidate } from "../litellm/client";

export function runtimeRouteKey(featureId: string, version: string) {
  return `minato-${featureId}-${version}`;
}

export function runtimeConfig(env = process.env) {
  if (!env.MINATO_RUNTIME_BASE_URL) throw new Error("MINATO_RUNTIME_BASE_URL is required");
  const base = new URL(env.MINATO_RUNTIME_BASE_URL);
  const publishBases = (env.MINATO_RUNTIME_PUBLISH_URLS ?? env.MINATO_RUNTIME_BASE_URL)
    .split(",").map((value) => new URL(value.trim())).filter((value, index, values) => values.findIndex((item) => item.href === value.href) === index);
  const token = env.MINATO_RUNTIME_TOKEN;
  if (!token) throw new Error("MINATO_RUNTIME_TOKEN is required");
  return { base, publishBases, headers: { authorization: `Bearer ${token}` },
    publishHeaders: { authorization: `Bearer ${env.MINATO_RUNTIME_PUBLISH_TOKEN || token}` } };
}

export function createRuntime(env = process.env) {
  const { publishBases, publishHeaders } = runtimeConfig(env);
  async function requestAt(target: URL, path: string, init: RequestInit = {}) {
    return fetch(new URL(path, target), {
      ...init,
      headers: { ...publishHeaders, "content-type": "application/json", ...init.headers },
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
    const body = JSON.stringify({ alias, version, candidates: deployments.map(serialize) });
    const results = await Promise.all(publishBases.map(async (target) => {
      const response = await requestAt(target, `/internal/v1/routes/${encodeURIComponent(alias)}`, {
        method: "PUT", signal, body,
      });
      await response.body?.cancel();
      return response.ok;
    }));
    if (results.some((ok) => !ok)) throw new Error("runtime_route_publish_failed");
  }
  return {
    async stage(group: string, deployment: Candidate) {
      await publish(group, "1", [deployment]);
    },
    publish,
  };
}

