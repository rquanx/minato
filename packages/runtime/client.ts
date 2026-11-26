import type { Candidate, CredentialLookup } from "../litellm/client";
import { codexBase } from "../litellm/codex-auth";
import { googleSubscription, providerUrls } from "../contracts/providers";

export function runtimeRouteKey(featureId: string, version: string) {
  return `minato-${featureId}-${version}`;
}

export function runtimeFallbackKey(route: string, offset: number) {
  return `${route}-after-${offset}`;
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

export function createRuntime(env = process.env, resolveCredential?: CredentialLookup) {
  const { publishBases, publishHeaders } = runtimeConfig(env);
  async function requestAt(target: URL, path: string, init: RequestInit = {}) {
    return fetch(new URL(path, target), {
      ...init,
      headers: { ...publishHeaders, "content-type": "application/json", ...init.headers },
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      redirect: "error",
    });
  }
  async function serialize(entry: Candidate) {
    if (entry.subscription) {
      if (!entry.credentialId || entry.apiBase.replace(/\/$/, "") !== providerUrls[entry.subscription]?.base) {
        throw new Error("runtime_invalid_subscription_candidate");
      }
      const relay = env.MINATO_PROVIDER_RELAY_BASE_URL;
      if (!relay) throw new Error("runtime_provider_relay_missing");
      return { sourceId: entry.sourceId, modelId: entry.modelId,
        apiBase: new URL("/internal/providers/" + entry.subscription, relay).href,
        endpoint: googleSubscription(entry.subscription) ? "gemini-generate" : entry.upstreamEndpoint,
        relativeApiBase: true, headers: { "x-minato-provider-token": env.MINATO_RUNTIME_PUBLISH_TOKEN || env.MINATO_RUNTIME_TOKEN,
          "x-minato-source": entry.sourceId, "x-minato-credential-id": entry.credentialId } };
    }
    if (entry.codex && (!entry.credentialId || entry.apiBase.replace(/\/$/, "") !== codexBase || entry.upstreamEndpoint !== "responses")) {
      throw new Error("runtime_invalid_codex_candidate");
    }
    const apiKey = entry.credentialId && await resolveCredential?.(entry.sourceId, entry.credentialId, entry.apiBase);
    if (!apiKey && (entry.credentialId || !entry.credentialEnv || !env[entry.credentialEnv])) throw new Error("upstream_credential_missing");
    const relay = entry.codex && env.MINATO_PROVIDER_RELAY_BASE_URL;
    if (entry.codex && !relay) throw new Error("runtime_provider_relay_missing");
    const apiBase = relay ? new URL("/internal/providers/codex", relay).href : entry.apiBase;
    return { sourceId: entry.sourceId, modelId: entry.modelId, apiBase,
      ...(apiKey ? { apiKey } : { credentialRef: entry.credentialEnv }), endpoint: entry.upstreamEndpoint,
      ...(relay ? { relativeApiBase: true, headers: { "x-minato-provider-token": env.MINATO_RUNTIME_PUBLISH_TOKEN || env.MINATO_RUNTIME_TOKEN } }
        : { relativeApiBase: entry.relativeApiBase }) };
  }
  async function publish(alias: string, version: string, deployments: Candidate[], signal?: AbortSignal) {
    const body = JSON.stringify({ alias, version, candidates: await Promise.all(deployments.map(serialize)) });
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
    async remove(alias: string) {
      await Promise.all(publishBases.map(async (target) => {
        const response = await requestAt(target, `/internal/v1/routes/${encodeURIComponent(alias)}`, { method: "DELETE" });
        await response.body?.cancel();
        if (!response.ok && response.status !== 404) throw new Error("runtime_route_remove_failed");
      }));
    },
  };
}

