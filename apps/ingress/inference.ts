import { z } from "zod";
import { ApiError, endpoint, endpointPaths, runtimeOnlyEndpoint, uploadEndpoints } from "../../packages/contracts";
import { candidate, liteLlmConfig, modelGroup, type CredentialLookup } from "../../packages/litellm/client";
import { createRuntime, runtimeConfig, runtimeFallbackKey, runtimeRouteKey } from "../../packages/runtime/client";
import { upstreamDescription, upstreamFailure } from "../../packages/contracts/upstream-errors";

const common = ["model", "stream", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "stop"];
const allowed = {
  responses: new Set([...common, "input", "instructions", "max_output_tokens", "reasoning", "text", "truncation"]),
  "chat-completions": new Set([...common, "messages", "max_tokens", "max_completion_tokens", "response_format", "stream_options", "seed", "frequency_penalty", "presence_penalty"]),
  embeddings: new Set(["model", "input", "encoding_format", "dimensions", "user"]),
};

export type Endpoint = z.infer<typeof endpoint>;
export const routeSnapshot = z.object({
  id: z.uuid(), version: z.string(), alias: z.string(),
  requirements: z.object({ endpoint, streaming: z.boolean().optional() }),
  candidates: z.array(candidate).min(1),
});
export type Snapshot = z.infer<typeof routeSnapshot>;
export type Attempt = {
  id: string; modelId: string; sourceId: string; status: number; durationMs: number; retryable: boolean;
  usage?: unknown;
  errorCode?: string;
};

export function validateInput(body: unknown, path: Endpoint) {
  const parsed = z.record(z.string(), z.unknown()).safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_request", "Expected a JSON object");
  const input = parsed.data;
  if (typeof input.model !== "string" || !input.model) throw new ApiError(400, "model_required", "Model is required");
  if (input.stream !== undefined && typeof input.stream !== "boolean") throw new ApiError(400, "invalid_stream", "Stream must be a boolean");
  for (const key of Object.keys(input)) {
    const fields = allowed[path as keyof typeof allowed];
    if (fields && !fields.has(key)) throw new ApiError(400, "unsupported_parameter", `Unsupported parameter: ${key}`);
  }
  if (path === "responses" && typeof input.input !== "string" && !Array.isArray(input.input)) {
    throw new ApiError(400, "invalid_input", "Responses input must be text or an array");
  }
  if (path === "chat-completions" && (!Array.isArray(input.messages) || !input.messages.length)) {
    throw new ApiError(400, "invalid_messages", "Chat Completions requires messages");
  }
  if (path === "embeddings" && input.stream !== undefined) {
    throw new ApiError(400, "unsupported_parameter", "Embeddings does not support streaming");
  }
  if (path === "anthropic-messages" && (!Array.isArray(input.messages) || !input.messages.length)) {
    throw new ApiError(400, "invalid_messages", "Messages requires a non-empty messages array");
  }
  if (input.stream && ["moderations", "rerank", "ocr", "translation"].includes(path)) {
    throw new ApiError(400, "streaming_unavailable", "This endpoint does not support SSE streaming");
  }
  return input as Record<string, unknown> & { model: string; stream?: boolean };
}

export function createInference(env = process.env, resolveCredential?: CredentialLookup) {
  if (env.MINATO_DATA_PLANE === "runtime") return createRuntimeInference(env, resolveCredential);
  const { base, headers } = liteLlmConfig(env);
  return async function infer(options: {
    snapshot: Snapshot;
    body: ReturnType<typeof validateInput>;
    sessionHeader?: string;
    groupOverride?: string;
    upload?: FormData;
    signal: AbortSignal;
    onAttempt?: (attempt: Attempt) => void;
    onAttemptStart?: (attempt: { id: string; sourceId: string; modelId: string }) => void;
  }) {
    const { snapshot, body } = options;
    if (runtimeOnlyEndpoint(snapshot.requirements.endpoint)) throw new ApiError(422, "endpoint_requires_go_runtime", "This endpoint requires the Go Runtime");
    const path = endpointPaths[snapshot.requirements.endpoint];
    if (body.stream && snapshot.requirements.streaming === false) {
      throw new ApiError(400, "streaming_unavailable", "This feature does not support streaming");
    }
    const deadline = AbortSignal.timeout(120_000);
    let lastStatus = 502;
    let failure = "upstream_error";
    for (const [i, deployment] of snapshot.candidates.entries()) {
      const more = i + 1 < snapshot.candidates.length;
      const id = crypto.randomUUID();
      const start = performance.now();
      const details = { id, modelId: deployment.modelId, sourceId: deployment.sourceId };
      options.onAttemptStart?.(details);
      const connect = new AbortController();
      const timer = setTimeout(() => connect.abort(), 5_000);
      const signal = AbortSignal.any([options.signal, deadline, connect.signal]);
      const attemptHeaders: Record<string, string> = { ...headers, "content-type": "application/json", "x-litellm-call-id": id };
      if (options.sessionHeader && deployment.sourceId.startsWith("opencode")) {
        attemptHeaders["x-opencode-session"] = options.sessionHeader;
      }
      let response: Response;
      try {
        response = await fetch(new URL(path, base), {
          method: "POST", headers: attemptHeaders, redirect: "error", signal,
          body: JSON.stringify({ ...body, model: options.groupOverride ?? modelGroup(snapshot.id, snapshot.version, i), disable_fallbacks: true }),
        });
      } catch {
        lastStatus = connect.signal.aborted || deadline.aborted ? 504 : 502;
        failure = "upstream_unreachable";
        options.onAttempt?.({ ...details, status: lastStatus, durationMs: performance.now() - start, retryable: !options.signal.aborted });
        if (!more || options.signal.aborted || deadline.aborted) break;
        continue;
      } finally {
        clearTimeout(timer);
      }
      lastStatus = response.status;
      failure = "upstream_error";
      if (response.ok && body.stream) {
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
          await response.body?.cancel();
          lastStatus = 502;
          options.onAttempt?.({ ...details, status: lastStatus, durationMs: performance.now() - start, retryable: true });
          continue;
        }
        try {
          const stream = await startSse(response.body, snapshot.alias);
          options.onAttempt?.({ ...details, status: lastStatus, durationMs: performance.now() - start, retryable: false });
          return { status: lastStatus, stream };
        } catch (error) {
          if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
            options.onAttempt?.({ ...details, status: error.status, durationMs: performance.now() - start, retryable: false });
            throw error;
          }
          lastStatus = error instanceof ApiError ? error.status : 502;
          options.onAttempt?.({ ...details, status: lastStatus, durationMs: performance.now() - start, retryable: true });
          if (options.signal.aborted || deadline.aborted) break;
          continue;
        }
      }
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (response.ok && payload) {
        options.onAttempt?.({ ...details, status: lastStatus, durationMs: performance.now() - start, retryable: false, usage: payload.usage });
        return { status: lastStatus, payload: { ...payload, model: snapshot.alias } };
      }
      if (response.ok) lastStatus = 502;
      failure = upstreamFailure(lastStatus, payload);
      const retryable = [408, 409, 429].includes(lastStatus) || lastStatus >= 500 ||
        ["model_unavailable", "model_region_unavailable"].includes(failure);
      options.onAttempt?.({ ...details, status: lastStatus, durationMs: performance.now() - start, retryable, errorCode: failure });
      if (!retryable || !more || options.signal.aborted || deadline.aborted) break;
    }
    throw new ApiError(lastStatus, failure, upstreamDescription(failure)!);
  };
}

function createRuntimeInference(env: NodeJS.ProcessEnv, resolveCredential?: CredentialLookup) {
  const { base, headers } = runtimeConfig(env);
  const runtime = createRuntime(env, resolveCredential);
  return async function infer(options: {
    snapshot: Snapshot;
    body: ReturnType<typeof validateInput>;
    sessionHeader?: string;
    groupOverride?: string;
    upload?: FormData;
    signal: AbortSignal;
    onAttempt?: (attempt: Attempt) => void;
    onAttemptStart?: (attempt: { id: string; sourceId: string; modelId: string }) => void;
  }) {
    const { snapshot, body } = options;
    if (body.stream && snapshot.requirements.streaming === false) {
      throw new ApiError(400, "streaming_unavailable", "This feature does not support streaming");
    }
    const id = crypto.randomUUID();
    const started = performance.now();
    let first = snapshot.candidates[0];
    const key = options.groupOverride ?? runtimeRouteKey(snapshot.id, snapshot.version);
    options.onAttemptStart?.({ id, sourceId: first.sourceId, modelId: first.modelId });
    const attemptHeaders: Record<string, string> = { ...headers, "x-minato-request-id": id };
    if (options.sessionHeader) attemptHeaders["x-opencode-session"] = options.sessionHeader;
    const endpoint = snapshot.requirements.endpoint;
    const path = endpointPaths[endpoint];
    if (!options.upload) attemptHeaders["content-type"] = "application/json";
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
    async function dispatch(model: string, offset: number) {
      const send = () => {
        options.upload?.set("model", model);
        return fetch(new URL(path, base), {
          method: "POST", headers: { ...attemptHeaders, "x-minato-request-id": offset ? crypto.randomUUID() : id },
          redirect: "error", signal, body: options.upload ?? JSON.stringify({ ...body, model }),
        });
      };
      const response = await send();
      if (response.status !== 404 || response.headers.get("x-minato-runtime-route-missing") !== "1") return response;
      await response.body?.cancel();
      await runtime.publish(model, options.groupOverride ? "1" : snapshot.version, snapshot.candidates.slice(offset), signal);
      return send();
    }
    function reportAttempts(response: Response, errorCode?: string, retried = false) {
      const encoded = response.headers.get("x-minato-runtime-attempt-log");
      if (!encoded) return false;
      try {
        const attempts = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Array<Record<string, unknown>>;
        for (const [index, attempt] of attempts.entries()) {
          if (typeof attempt.id !== "string" || typeof attempt.sourceId !== "string" || typeof attempt.modelId !== "string") continue;
          const last = index === attempts.length - 1;
          options.onAttempt?.({ id: attempt.id, sourceId: attempt.sourceId, modelId: attempt.modelId,
            status: Number(attempt.status) || response.status, durationMs: Number(attempt.durationMs) || 0,
            retryable: Boolean(attempt.retryable) || (last && retried), usage: attempt.usage,
            errorCode: last ? errorCode : undefined });
        }
        return attempts.length > 0;
      } catch { return false; }
    }
    let response: Response;
    let payload: Record<string, unknown> | null = null;
    let failure = "upstream_error";
    let offset = 0;
    try {
      while (true) {
        first = snapshot.candidates[offset];
        response = await dispatch(offset ? runtimeFallbackKey(key, offset) : key, offset);
        if (response.ok) break;
        payload = await response.json().catch(() => null) as Record<string, unknown> | null;
        failure = upstreamFailure(response.status, payload);
        // Older runtimes stop on this provider-specific 400 even when another model is available.
        if (failure !== "model_region_unavailable" || options.groupOverride) break;
        const failed = snapshot.candidates.findIndex((candidate, i) => i >= offset &&
          candidate.sourceId === response.headers.get("x-minato-runtime-source") &&
          candidate.modelId === response.headers.get("x-minato-runtime-model"));
        if (failed < offset || failed + 1 >= snapshot.candidates.length || signal.aborted) break;
        if (!reportAttempts(response, failure, true)) {
          options.onAttempt?.({ id: crypto.randomUUID(), sourceId: snapshot.candidates[failed].sourceId,
            modelId: snapshot.candidates[failed].modelId, status: response.status,
            durationMs: performance.now() - started, retryable: true, errorCode: failure });
        }
        offset = failed + 1;
      }
    } catch {
      options.onAttempt?.({ id: offset ? crypto.randomUUID() : id, sourceId: first.sourceId, modelId: first.modelId,
        status: 504, durationMs: performance.now() - started, retryable: !options.signal.aborted });
      throw new ApiError(504, "upstream_unreachable", upstreamDescription("upstream_unreachable")!);
    }
    const sourceId = response.headers.get("x-minato-runtime-source") || first.sourceId;
    const actualModelId = response.headers.get("x-minato-runtime-model") || first.modelId;
    const attemptId = offset ? crypto.randomUUID() : id;
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && response.body && (endpoint === "speech" || uploadEndpoints.has(endpoint)) &&
      !contentType.includes("json") && !contentType.includes("text/event-stream")) {
      if (!reportAttempts(response)) options.onAttempt?.({ id: attemptId, sourceId, modelId: actualModelId, status: response.status, durationMs: performance.now() - started, retryable: false });
      return { status: response.status, media: response.body, contentType: contentType || "application/octet-stream" };
    }
    if (response.ok && body.stream) {
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel();
        options.onAttempt?.({ id: attemptId, sourceId, modelId: actualModelId, status: 502, durationMs: performance.now() - started, retryable: false });
        throw new ApiError(502, "upstream_error", "Runtime returned an invalid stream");
      }
      const stream = await startSse(response.body, snapshot.alias);
      if (!reportAttempts(response)) options.onAttempt?.({ id: attemptId, sourceId, modelId: actualModelId, status: response.status, durationMs: performance.now() - started, retryable: false });
      return { status: response.status, stream };
    }
    if (response.ok) payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!reportAttempts(response, response.ok ? undefined : failure)) options.onAttempt?.({ id: attemptId, sourceId, modelId: actualModelId,
      status: response.status, durationMs: performance.now() - started, retryable: !response.ok && (response.status === 429 || response.status >= 500),
      usage: payload?.usage, errorCode: response.ok ? undefined : failure });
    if (response.ok && payload) return { status: response.status, payload: { ...payload, model: snapshot.alias } };
    throw new ApiError(response.status >= 400 ? response.status : 502, failure, upstreamDescription(failure)!);
  };
}

function rewriteEvent(frame: string, alias: string) {
  const lines = frame.split(/\r?\n/);
  return lines.map((line) => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return line;
    let event: Record<string, unknown>;
    try { event = JSON.parse(data); } catch { return line; }
    if (!event || typeof event !== "object") return line;
    if ("model" in event) event.model = alias;
    if (event.response && typeof event.response === "object" && "model" in event.response) {
      (event.response as Record<string, unknown>).model = alias;
    }
    if (event.message && typeof event.message === "object" && "model" in event.message) {
      (event.message as Record<string, unknown>).model = alias;
    }
    return "data: " + JSON.stringify(event);
  }).join("\n");
}

export async function startSse(body: ReadableStream<Uint8Array>, alias: string) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  async function readFrame() {
    while (true) {
      const delimiter = /\r?\n\r?\n/.exec(buffer);
      if (delimiter) {
        if (delimiter.index > 256 * 1024) throw new Error("SSE frame exceeds buffer limit");
        const frame = buffer.slice(0, delimiter.index);
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        return frame;
      }
      if (buffer.length > 256 * 1024) throw new Error("SSE frame exceeds buffer limit");
      const result = await reader.read();
      if (result.done) return null;
      buffer += decoder.decode(result.value, { stream: true });
    }
  }
  let first: string | null;
  try {
    do {
      first = await readFrame();
    } while (first !== null && !/(?:^|\n)data:\s*\S/.test(first));
    if (first === null || /^data:\s*\[DONE\]\s*$/.test(first)) {
      throw new ApiError(502, "upstream_empty_stream", "Upstream stream closed before data");
    }
    const data = first.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5);
    const event = JSON.parse(data ?? "{}");
    if (event?.error || event?.type === "error" || event?.type === "response.failed") {
      const error = event.error ?? event.response?.error;
      const rateLimited = error?.type === "rate_limit_error" || error?.code === "rate_limit_exceeded";
      const invalid = error?.type === "invalid_request_error";
      throw new ApiError(rateLimited ? 429 : invalid ? 400 : 502, "upstream_stream_failure", "Upstream stream failed");
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(rewriteEvent(first!, alias) + "\n\n")); },
    async pull(controller) {
      try {
        const frame = await readFrame();
        if (frame === null) {
          if (buffer.trim()) throw new Error("Incomplete SSE frame");
          controller.close();
        } else {
          controller.enqueue(encoder.encode(rewriteEvent(frame, alias) + "\n\n"));
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}
