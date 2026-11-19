import { z } from "zod";
import { ApiError, endpoint } from "../../packages/contracts";
import { candidate, liteLlmConfig, modelGroup } from "../../packages/litellm/client";

const common = ["model", "stream", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "stop"];
const allowed = {
  responses: new Set([...common, "input", "instructions", "max_output_tokens", "reasoning", "text", "truncation"]),
  "chat-completions": new Set([...common, "messages", "max_tokens", "max_completion_tokens", "response_format", "stream_options", "seed", "frequency_penalty", "presence_penalty"]),
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
};

export function validateInput(body: unknown, path: Endpoint) {
  const parsed = z.record(z.string(), z.unknown()).safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_request", "Expected a JSON object");
  const input = parsed.data;
  if (typeof input.model !== "string" || !input.model) throw new ApiError(400, "model_required", "Model is required");
  if (input.stream !== undefined && typeof input.stream !== "boolean") throw new ApiError(400, "invalid_stream", "Stream must be a boolean");
  for (const key of Object.keys(input)) {
    if (!allowed[path].has(key)) throw new ApiError(400, "unsupported_parameter", `Unsupported parameter: ${key}`);
  }
  if (path === "responses" && typeof input.input !== "string" && !Array.isArray(input.input)) {
    throw new ApiError(400, "invalid_input", "Responses input must be text or an array");
  }
  if (path === "chat-completions" && (!Array.isArray(input.messages) || !input.messages.length)) {
    throw new ApiError(400, "invalid_messages", "Chat Completions requires messages");
  }
  return input as Record<string, unknown> & { model: string; stream?: boolean };
}

export function createInference(env = process.env) {
  const { base, headers } = liteLlmConfig(env);
  return async function infer(options: {
    snapshot: Snapshot;
    body: ReturnType<typeof validateInput>;
    sessionHeader?: string;
    groupOverride?: string;
    signal: AbortSignal;
    onAttempt?: (attempt: Attempt) => void;
    onAttemptStart?: (attempt: { id: string; sourceId: string; modelId: string }) => void;
  }) {
    const { snapshot, body } = options;
    const path = snapshot.requirements.endpoint === "responses" ? "/v1/responses" : "/v1/chat/completions";
    if (body.stream && snapshot.requirements.streaming === false) {
      throw new ApiError(400, "streaming_unavailable", "This feature does not support streaming");
    }
    const deadline = AbortSignal.timeout(120_000);
    let lastStatus = 502;
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
        options.onAttempt?.({ ...details, status: lastStatus, durationMs: performance.now() - start, retryable: !options.signal.aborted });
        if (!more || options.signal.aborted || deadline.aborted) break;
        continue;
      } finally {
        clearTimeout(timer);
      }
      lastStatus = response.status;
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
      const error = payload?.error as { code?: unknown; type?: unknown } | undefined;
      const unavailable = error?.code === "model_not_found" || error?.type === "model_not_found";
      const retryable = lastStatus === 429 || lastStatus >= 500 || unavailable;
      options.onAttempt?.({ ...details, status: lastStatus, durationMs: performance.now() - start, retryable });
      if (!retryable || !more || options.signal.aborted || deadline.aborted) break;
    }
    throw new ApiError(lastStatus, "upstream_error", lastStatus === 400 || lastStatus === 422
      ? "Upstream rejected the request parameters" : "Upstream request could not be completed");
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
