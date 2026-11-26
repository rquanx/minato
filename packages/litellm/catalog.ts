import { z } from "zod";
import { endpoint } from "../contracts";
import { providerDefaultEndpoints, type ProviderKind } from "../contracts/providers";
import { codexHeaders } from "./codex-auth";
import { claudeHeaders, kimiHeaders } from "./subscription-auth";
import type { TokenBundle } from "./provider-auth";

export const sourceFields = z.strictObject({
  kind: z.enum(Object.keys(providerDefaultEndpoints) as ProviderKind[]),
  directoryUrl: z.url({ protocol: /^https?$/ }).optional(),
  apiBase: z.url({ protocol: /^https?$/ }),
  credentialEnv: z.string().regex(/^MINATO_UPSTREAM_[A-Z][A-Z0-9_]*$/).nullish(),
  defaultEndpoint: endpoint,
  enabled: z.boolean().default(true),
  directoryEnabled: z.boolean().default(true),
});
export const capabilities = z.strictObject({
  upstreamEndpoint: endpoint.optional(),
  apiBase: z.url({ protocol: /^https?$/ }).optional(),
  contextTokens: z.number().int().positive().optional(),
  structuredOutput: z.enum(["json_object", "json_schema"]).optional(),
  streaming: z.boolean().optional(),
  tools: z.boolean().optional(),
  embeddingSpace: z.string().trim().min(1).max(160).optional(),
  embeddingDimensions: z.number().int().positive().optional(),
  inputPricePerMillion: z.number().nonnegative().optional(),
  outputPricePerMillion: z.number().nonnegative().optional(),
  cachedInputPricePerMillion: z.number().nonnegative().optional(),
  priceCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
});
const directory = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(256) }).loose()).max(20_000),
  has_more: z.boolean().optional(),
  next: z.string().nullish(),
  last_id: z.string().nullish(),
});

export class CatalogError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}

const credentialErrors = new Set(["upstream_credential_missing", "upstream_credential_unreadable", "upstream_credential_origin_mismatch",
  "upstream_credential_expired"]);
export function catalogFailure(error: unknown) {
  if (error instanceof CatalogError) return error;
  if (error instanceof Error && credentialErrors.has(error.message)) return new CatalogError(error.message);
  return new CatalogError("catalog_sync_failed");
}

export function validateUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error("invalid_source_url");
  return url;
}

export async function readCatalog(options: {
  directory_url: string; credential_env: string | null; kind: string;
}, env = process.env, managedKey?: string, bundle?: Pick<TokenBundle, "deviceId">) {
  const initial = validateUrl(options.directory_url);
  const secret = managedKey ?? (options.credential_env ? env[options.credential_env] : undefined);
  if (!secret) throw new Error("upstream_credential_missing");
  let page: URL | undefined = initial;
  const models = new Map<string, object>();
  const visited = new Set<string>();
  const signal = AbortSignal.timeout(10_000);
  while (page) {
    if (page.origin !== initial.origin || visited.has(page.href) || visited.size >= 20) {
      throw new CatalogError("catalog_pagination_incomplete");
    }
    visited.add(page.href);
    let headers: Record<string, string> = options.kind === "anthropic"
      ? { "x-api-key": secret, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${secret}` };
    if (options.kind === "codex") headers = codexHeaders(secret);
    if (options.kind === "claude") headers = claudeHeaders(secret);
    if (options.kind === "kimi") {
      if (!bundle?.deviceId) throw new Error("upstream_credential_unreadable");
      Object.assign(headers, kimiHeaders(bundle.deviceId));
    }
    const response = await fetch(page, { headers, signal, redirect: "error" }).catch(() => {
      throw new CatalogError(signal.aborted ? "catalog_timeout" : "catalog_unreachable");
    });
    if (!response.ok) {
      await response.body?.cancel();
      const code = [401, 403].includes(response.status) ? "catalog_authentication"
        : response.status === 404 ? "catalog_not_found" : response.status === 429 ? "catalog_rate_limited"
        : "catalog_http_error";
      throw new CatalogError(code, response.status);
    }
    let raw = await response.json().catch(() => {
      throw new CatalogError(signal.aborted ? "catalog_timeout" : "catalog_invalid_response");
    });
    if (options.kind === "codex" && Array.isArray(raw?.models)) {
      raw = { data: raw.models.filter((model: any) => model?.visibility !== "hide")
        .map((model: any) => ({ id: model?.slug, supports_streaming: true })) };
    }
    const parsed = directory.safeParse(raw);
    if (!parsed.success) throw new CatalogError("catalog_invalid_response");
    const { data, has_more, next, last_id } = parsed.data;
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
      const native = new Map([
        ["responses", "responses"], ["chat-completions", "chat-completions"],
        ["chat_completions", "chat-completions"], ["chat", "chat-completions"],
        ["messages", "anthropic-messages"], ["embeddings", "embeddings"],
      ]);
      const selected = [details?.recommended_api, ...native.keys()]
        .find((name) => name && native.has(name) && Object.hasOwn(apis, name));
      const advertised = selected ? apis[selected]?.base_url : undefined;
      let apiBase: string | undefined;
      if (advertised) {
        try {
          const url = validateUrl(advertised);
          if (url.origin === initial.origin && !url.search) apiBase = url.href.replace(/\/$/, "");
        } catch { /* Keep the configured base for unusable metadata. */ }
      }
      const contextTokens = details?.limit?.context ?? model.context_length ?? model.context_window;
      const supportedEndpoint = selected && native.get(selected);
      const upstream = apiBase ? supportedEndpoint ?? model.endpoint_type : model.endpoint_type;
      models.set(id, {
        ...(Object.keys(apis).length && !supportedEndpoint ? { protocolUnsupported: true } : {}),
        ...(typeof contextTokens === "number" && Number.isSafeInteger(contextTokens) && contextTokens > 0 ? { contextTokens } : {}),
        ...(endpoint.safeParse(upstream).success ? { upstreamEndpoint: upstream } : {}),
        ...(supportedEndpoint && apiBase ? { apiBase } : {}),
        ...(model.supports_streaming === true ? { streaming: true } : {}),
        ...(model.supports_tools === true || details?.capabilities?.tools?.supported === true ? { tools: true } : {}),
        ...(model.supports_structured_output === true || details?.capabilities?.structured_output === true
          ? { structuredOutput: "json_schema" } : {}),
      });
    }
    if (next) page = validateUrl(new URL(next, page).href);
    else if (has_more && ["anthropic", "claude"].includes(options.kind) && last_id) {
      page = new URL(page);
      page.searchParams.set("after_id", last_id);
    } else {
      if (has_more) throw new CatalogError("catalog_pagination_incomplete");
      page = undefined;
    }
  }
  return Array.from(models, ([id, metadata]) => ({ id, metadata }));
}
