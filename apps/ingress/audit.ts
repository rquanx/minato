import { auditCipher, capture, type AuditPolicy } from "../../packages/db/audit";
import type { connectDatabase } from "../../packages/db/client";
import type { Attempt, Endpoint, Snapshot } from "./inference";
import { saveUsage } from "../../packages/db/usage";

export function createAudit(db: ReturnType<typeof connectDatabase>, env = process.env) {
  const cipher = auditCipher(env);
  let queued = 0;
  let lost = 0;
  const pending = new Set<Promise<void>>();
  async function flush() { await Promise.all(pending); }
  function start(options: {
    id: string; environmentId: string; snapshot: Snapshot; endpoint: Endpoint; body: unknown;
    policy: AuditPolicy; kind?: "production" | "test" | "replay";
  }) {
    const { id, environmentId, snapshot, endpoint, body, policy } = options;
    const enabled = policy.enabled && !!cipher;
    let tail = Promise.resolve();
    function enqueue(write: () => Promise<unknown>) {
      if (queued >= 1024) { lost++; return; }
      queued++;
      tail = tail.then(async () => { await write(); }).catch(() => { lost++; }).finally(() => {
        queued--;
        pending.delete(task);
      });
      const task = tail;
      pending.add(task);
    }
    function protect(kind: "request" | "response", value: unknown, state?: string) {
      if (!enabled || !cipher) return;
      const recorded = capture(value, policy);
      const sealed = cipher.seal(recorded.text, `${id}:${kind}`);
      const captureState = recorded.state === "truncated" ? "truncated" : state ?? recorded.state;
      enqueue(() => db`insert into call_content (request_id, kind, sealed, capture_state, expires_at)
        values (${id}, ${kind}, ${sealed}, ${captureState}, now() + ${policy.retentionDays} * interval '1 day')
        on conflict (request_id, kind) do nothing`);
    }
    enqueue(() => db`insert into calls (request_id, environment_id, feature_id, route_version, kind, endpoint, capture_state)
      values (${id}, ${environmentId}, ${snapshot.id}, ${snapshot.version}::bigint,
        ${options.kind ?? "production"}, ${endpoint}, ${enabled ? "pending" : policy.enabled ? "unavailable" : "disabled"})
      on conflict (request_id) do nothing`);
    protect("request", body);
    return {
      record(attempt: Attempt) {
        enqueue(async () => {
          await db`insert into call_attempts (id, request_id, source_id, model_id, http_status, duration_ms, retryable)
          values (${attempt.id}, ${id}, ${attempt.sourceId}, ${attempt.modelId}, ${attempt.status},
            ${Math.round(attempt.durationMs)}, ${attempt.retryable})
          on conflict (id) do nothing`;
          if (attempt.usage) await saveUsage(db, attempt.id, attempt.usage);
        });
      },
      usage(attemptId: string, usage: unknown) { enqueue(() => saveUsage(db, attemptId, usage)); },
      finish(status: string, httpStatus: number, duration: number, response: unknown) {
        protect("response", response, status === "interrupted" ? "partial" : undefined);
        enqueue(() => db`update calls set status = ${status}, http_status = ${httpStatus}, duration_ms = ${Math.round(duration)},
          capture_state = case when capture_state = 'pending' then
            case when (select count(*) from call_content where request_id = ${id}) = 2 then 'captured' else 'partial' end
            else capture_state end where request_id = ${id}`);
      },
      streamLimit: enabled ? policy.contentLimit : 0,
    };
  }
  return { start, flush, stats: () => ({ queued, lost }) };
}

export function observeSse(stream: ReadableStream<Uint8Array>, endpoint: Endpoint, policy: AuditPolicy, captureLimit: number,
  finish: (state: string, detail: unknown, usage: unknown) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  let truncated = false;
  let terminal = false;
  let failed = false;
  let done = false;
  let usage: unknown;
  function end(status: string) {
    if (done) return;
    done = true;
    finish(status, { format: "sse", events: captured, truncated }, usage);
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          end(terminal && !failed ? "succeeded" : "interrupted");
          controller.close();
          return;
        }
        const frame = decoder.decode(result.value);
        if (endpoint === "chat-completions") terminal ||= /(?:^|\n)data:\s*\[DONE\]/.test(frame);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
          try {
            const event = JSON.parse(line.slice(5));
            terminal ||= endpoint === "responses" && event.type === "response.completed";
            failed ||= !!event.error || ["error", "response.failed", "response.incomplete"].includes(event.type);
            usage = event.usage ?? event.response?.usage ?? usage;
            if (!captureLimit || truncated) continue;
            const sanitized = capture(event, policy);
            const next = sanitized.text + "\n";
            truncated = sanitized.state === "truncated" || captured.length + next.length > captureLimit;
            if (!truncated) captured += next;
          } catch { /* malformed frames are not capturable */ }
        }
        controller.enqueue(result.value);
      } catch (error) {
        end("interrupted");
        controller.error(error);
      }
    },
    cancel(reason) {
      end("cancelled");
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}
