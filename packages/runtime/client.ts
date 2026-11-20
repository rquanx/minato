import { z } from "zod";
import { candidate, type Candidate } from "../litellm/client";

export { candidate };
export type { Candidate };

export function runtimeConfig(env = process.env) {
  if (!env.MINATO_RUNTIME_BASE_URL) throw new Error("MINATO_RUNTIME_BASE_URL is required");
  const base = new URL(env.MINATO_RUNTIME_BASE_URL);
  const token = env.MINATO_RUNTIME_TOKEN;
  return { base, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

export function createRuntime(env = process.env) {
  const { base, headers } = runtimeConfig(env);
  async function request(path: string, init: RequestInit = {}) {
    return fetch(new URL(path, base), {
      ...init,
      headers: { ...headers, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  }
  function serialize(entry: Candidate) {
    const apiKey = env[entry.credentialEnv];
    if (!apiKey) throw new Error("upstream_credential_missing");
    return { sourceId: entry.sourceId, modelId: entry.modelId, apiBase: entry.apiBase,
      apiKey, endpoint: entry.upstreamEndpoint };
  }
  async function publish(alias: string, version: string, deployments: Candidate[]) {
    const response = await request(`/internal/v1/routes/${encodeURIComponent(alias)}`, {
      method: "PUT",
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

export type RuntimeClient = ReturnType<typeof createRuntime>;

export const runtimeRoute = z.object({ alias: z.string(), version: z.string(), candidates: z.array(candidate) });
