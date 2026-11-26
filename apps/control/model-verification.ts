import { ApiError, endpoint, endpointPaths } from "../../packages/contracts";
import { upstreamFailure } from "../../packages/contracts/upstream-errors";
import { googleSubscription, providerDefaultEndpoints, providerUrls, relativeProviderBase, subscriptionRelay, type ProviderKind } from "../../packages/contracts/providers";
import { subscriptionRequest, unwrapCloudResponse } from "../../packages/litellm/subscription-inference";
import type { TokenBundle } from "../../packages/litellm/provider-auth";
import { codexBase, codexHeaders } from "../../packages/litellm/codex-auth";
import { codexRequest, codexResult } from "../../packages/litellm/codex-response";

const messages = [{ role: "user", content: "Reply with OK." }];
const probes: Partial<Record<keyof typeof endpointPaths, object>> = {
  responses: { input: "Reply with OK.", max_output_tokens: 32 },
  "chat-completions": { messages, max_completion_tokens: 32 },
  "anthropic-messages": { messages, max_tokens: 32 },
  completions: { prompt: "Reply with OK.", max_tokens: 8 },
  embeddings: { input: "Minato connection test" },
  moderations: { input: "Minato connection test" },
  rerank: { query: "connection test", documents: ["connection test", "other text"], top_n: 1 },
};
const resultKeys: Partial<Record<keyof typeof endpointPaths, string>> = {
  responses: "output", embeddings: "data", "anthropic-messages": "content",
  rerank: "results", moderations: "results",
};

export async function verifyModel(model: {
  modelId: string; apiBase: string; endpoint: unknown; kind: string;
}, key: string | undefined, prompt?: string, bundle?: Pick<TokenBundle, "projectId" | "deviceId">) {
  const protocol = endpoint.parse(model.endpoint);
  const codex = model.kind === "codex";
  const subscription = subscriptionRelay(model.kind);
  const google = googleSubscription(model.kind);
  if (subscription && (model.apiBase.replace(/\/$/, "") !== providerUrls[model.kind as ProviderKind]?.base
    || protocol !== providerDefaultEndpoints[model.kind as ProviderKind])) {
    throw new ApiError(422, "unsupported_endpoint", "Choose this subscription provider's native endpoint");
  }
  if (codex && (protocol !== "responses" || model.apiBase.replace(/\/$/, "") !== codexBase)) {
    throw new ApiError(422, "unsupported_endpoint", "Codex requires its official Responses endpoint");
  }
  const input = probes[protocol];
  if (!input) throw new ApiError(422, "probe_requires_input", "Use the inference API to test this endpoint with its required input");
  const chat = protocol === "chat-completions" || protocol === "anthropic-messages";
  if (prompt && !(chat || ["responses", "completions"].includes(protocol))) {
    throw new ApiError(422, "probe_prompt_unsupported", "Custom prompts are available for text generation models");
  }
  const payloadOverride = prompt && (chat ? { messages: [{ role: "user", content: prompt }] }
    : protocol === "completions" ? { prompt } : { input: prompt });
  if (!key) throw new ApiError(422, "upstream_credential_missing", "Configure the source credential before verifying a model");
  const headers = new Headers({ "content-type": "application/json" });
  if (protocol === "anthropic-messages") {
    headers.set("x-api-key", key);
    headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("authorization", `Bearer ${key}`);
  }
  if (model.kind === "opencode-go" || model.kind === "opencode-zen") {
    headers.set("x-opencode-session", crypto.randomUUID());
  }
  if (codex) {
    for (const [name, value] of Object.entries(codexHeaders(key))) headers.set(name, value);
    headers.set("accept", "text/event-stream");
  }
  const base = model.apiBase.replace(/\/$/, "");
  const url = base + (codex || base.endsWith("/v1") || relativeProviderBase(model.kind) ? endpointPaths[protocol].slice(3) : endpointPaths[protocol]);
  const started = performance.now();
  let code: string | null;
  let status: number | null = null;
  let sample: string | undefined;
  try {
    const body = { ...input, ...(payloadOverride || {}), model: model.modelId };
    const signal = AbortSignal.timeout(20_000);
    const response = subscription ? await subscriptionRequest(model.kind, model.modelId, google ? {
      contents: [{ role: "user", parts: [{ text: prompt ?? "Reply with OK." }] }], generationConfig: { maxOutputTokens: 32 },
    } : body, { ...bundle, accessToken: key }, false, signal) : await fetch(url, {
      method: "POST", headers, body: JSON.stringify(codex ? codexRequest(body) : body),
      signal, redirect: "error",
    });
    status = response.status;
    const codexCompletion = codex && response.ok && response.body;
    const reader = codexCompletion ? undefined : response.body?.getReader();
    let data = "";
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (data.length < 65_536) {
          const { value, done } = await reader.read();
          if (done) { data += decoder.decode(); break; }
          data += decoder.decode(value.subarray(0, 65_536 - data.length), { stream: true });
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }
    let payload: unknown;
    try { payload = codexCompletion ? await codexResult(codexCompletion) : JSON.parse(data); } catch { payload = null; }
    if (google && response.ok) payload = unwrapCloudResponse(payload);
    const resultKey = google ? "candidates" : resultKeys[protocol] ?? "choices";
    const expected = payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>)[resultKey]);
    code = response.ok ? (expected ? null : "unexpected_response") : upstreamFailure(status, payload);
    if (!code && ["responses", "chat-completions", "anthropic-messages", "completions"].includes(protocol)) {
      const body = payload as {
        output?: { content?: { type?: string; text?: string }[] }[];
        content?: { type?: string; text?: string }[];
        choices?: { message?: { content?: string }; text?: string }[];
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const content = protocol === "responses" && Array.isArray(body.output)
        ? body.output.flatMap((item) => Array.isArray(item?.content) ? item.content : []) : body.content;
      const text = Array.isArray(content)
        ? content.filter((entry) => ["text", "output_text"].includes(entry?.type ?? "") && typeof entry.text === "string")
          .map((entry) => entry.text).join("\n")
        : google ? body.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text
          : body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text;
      if (typeof text === "string" && text) sample = text.slice(0, 2048);
    }
  } catch {
    code = "upstream_unreachable";
  }
  return { verification: { checkedAt: new Date().toISOString(), status, code,
    durationMs: Math.round(performance.now() - started) }, sample };
}
