import { z } from "zod";
import { endpoint } from "../contracts";

export const sourceFields = z.strictObject({
  kind: z.enum(["cpa", "opencode-zen", "opencode-go", "openai"]),
  directoryUrl: z.url({ protocol: /^https?$/ }),
  apiBase: z.url({ protocol: /^https?$/ }),
  credentialEnv: z.string().regex(/^MINATO_UPSTREAM_[A-Z][A-Z0-9_]*$/),
  defaultEndpoint: endpoint,
  enabled: z.boolean().default(true),
});
export const capabilities = z.strictObject({
  upstreamEndpoint: endpoint.optional(),
  apiBase: z.url({ protocol: /^https?$/ }).optional(),
  contextTokens: z.number().int().positive().optional(),
  structuredOutput: z.enum(["json_object", "json_schema"]).optional(),
  streaming: z.boolean().optional(),
  tools: z.boolean().optional(),
});
const directory = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(256) }).loose()).max(20_000),
  has_more: z.boolean().optional(),
  next: z.string().nullish(),
});

export function validateUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error("invalid_source_url");
  return url;
}

export async function readCatalog(options: {
  directory_url: string; credential_env: string; kind: string;
}, env = process.env) {
  const initial = validateUrl(options.directory_url);
  const secret = env[options.credential_env];
  if (!secret) throw new Error("upstream_credential_missing");
  let page: URL | undefined = initial;
  const models = new Map<string, object>();
  const visited = new Set<string>();
  const signal = AbortSignal.timeout(10_000);
  while (page) {
    if (page.origin !== initial.origin || visited.has(page.href) || visited.size >= 20) {
      throw new Error("catalog_pagination_incomplete");
    }
    visited.add(page.href);
    const response = await fetch(page, {
      headers: { authorization: `Bearer ${secret}` }, signal, redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("catalog_http_error");
    }
    const { data, has_more, next } = directory.parse(await response.json());
    for (const { id, ...model } of data) {
      const code = options.kind === "opencode-zen" || options.kind === "opencode-go";
      const typed = z.object({
        limit: z.object({ context: z.number().optional() }).optional(),
        recommended_api: z.string().optional(),
        capabilities: z.object({
          tools: z.object({ supported: z.boolean().optional() }).optional(),
          structured_output: z.boolean().optional(),
        }).optional(),
        api: z.record(z.string(), z.object({ base_url: z.string().optional() })).optional(),
      }).safeParse(model);
      const details = code && typed.success ? typed.data : undefined;
      const apis = details?.api ?? {};
      const selected = [details?.recommended_api, "responses", "chat_completions", "chat"]
        .find((name) => name && Object.hasOwn(apis, name));
      const advertised = selected ? apis[selected]?.base_url : undefined;
      let apiBase: string | undefined;
      if (advertised) {
        try {
          const url = validateUrl(advertised);
          if (url.origin === initial.origin && !url.search) apiBase = url.href.replace(/\/$/, "");
        } catch { /* Keep the configured base for unusable metadata. */ }
      }
      const contextTokens = details?.limit?.context ?? model.context_length ?? model.context_window;
      const supportedEndpoint = selected === "responses" ? "responses"
        : selected === "chat_completions" || selected === "chat" ? "chat-completions" : undefined;
      const upstream = apiBase ? supportedEndpoint ?? model.endpoint_type : model.endpoint_type;
      models.set(id, {
        ...(typeof contextTokens === "number" && Number.isSafeInteger(contextTokens) && contextTokens > 0 ? { contextTokens } : {}),
        ...(upstream === "responses" || upstream === "chat-completions" ? { upstreamEndpoint: upstream } : {}),
        ...(supportedEndpoint && apiBase ? { apiBase } : {}),
        ...(model.supports_streaming === true ? { streaming: true } : {}),
        ...(model.supports_tools === true || details?.capabilities?.tools?.supported === true ? { tools: true } : {}),
        ...(model.supports_structured_output === true || details?.capabilities?.structured_output === true
          ? { structuredOutput: "json_schema" } : {}),
      });
    }
    if (has_more && !next) throw new Error("catalog_pagination_incomplete");
    page = next ? validateUrl(new URL(next, page).href) : undefined;
  }
  return Array.from(models, ([id, metadata]) => ({ id, metadata }));
}
