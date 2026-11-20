import { z } from "zod";
import { endpoint } from "../contracts";

export const candidate = z.strictObject({
  sourceId: z.string().min(1).max(160),
  modelId: z.string().min(1).max(256),
  apiBase: z.url({ protocol: /^https?$/ }).refine((url) => {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  }),
  credentialEnv: z.string().regex(/^MINATO_UPSTREAM_[A-Z][A-Z0-9_]*$/),
  upstreamEndpoint: endpoint,
});
export type Candidate = z.infer<typeof candidate>;

export function modelGroup(feature: string, version: string, index: number) {
  return `minato-${feature}-${version}-${index}`;
}

export function liteLlmConfig(env = process.env) {
  if (!env.LITELLM_MASTER_KEY) throw new Error("LITELLM_MASTER_KEY is required");
  const base = new URL(env.LITELLM_BASE_URL ?? "http://127.0.0.1:14000");
  const headers = { authorization: `Bearer ${env.LITELLM_MASTER_KEY}` };
  return { base, headers };
}

export function createLiteLlm(env = process.env) {
  const { base, headers } = liteLlmConfig(env);
  async function request(path: string, body?: unknown) {
    return fetch(new URL(path, base), {
      headers: { ...headers, "content-type": "application/json" },
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  }
  async function listIds() {
    const result = await request("/model/info");
    if (!result.ok) throw new Error("proxy_model_info_failed");
    const data = z.object({ data: z.array(z.object({
      model_name: z.string(), model_info: z.object({ id: z.string() }),
    })) }).parse(await result.json()).data;
    return new Set(data.filter(({ model_name, model_info }) => model_name === model_info.id).map(({ model_name }) => model_name));
  }
  return {
    async stage(group: string, deployment: Candidate) {
      if ((await listIds()).has(group)) return;
      const key = env[deployment.credentialEnv];
      if (!key) throw new Error("upstream_credential_missing");
      const prefix = deployment.upstreamEndpoint === "responses" ? "openai/" : "openai/chat_completions/";
      const endpoint = deployment.upstreamEndpoint === "responses" ? "/v1/responses" : "/v1/chat/completions";
      const response = await request("/model/new", {
        model_name: group,
        litellm_params: {
          model: prefix + deployment.modelId,
          api_base: deployment.apiBase.replace(/\/$/, ""),
          api_key: key,
        },
        model_info: { id: group, supported_endpoints: [endpoint] },
      });
      await response.body?.cancel();
      if (!(await listIds()).has(group)) throw new Error(response.ok ? "proxy_model_readback_failed" : "proxy_model_create_failed");
    },
    async publishRoute(featureId: string, version: string, deployments: Candidate[]) {
      for (const [index, deployment] of deployments.entries()) {
        await this.stage(modelGroup(featureId, version, index), deployment);
      }
    },
  };
}
