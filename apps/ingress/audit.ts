import { Database as Journal } from "bun:sqlite";
import { auditCipher, capture, type AuditPolicy } from "../../packages/db/audit";
import type { connectDatabase } from "../../packages/db/client";
import type { Attempt, Endpoint, Snapshot } from "./inference";
import { saveUsage } from "../../packages/db/usage";

type AuditEntry = {
  id: string; environmentId: string; featureId: string; routeVersion: string; endpoint: Endpoint;
  kind: string; correlationId: string | null; startedAt: string; status: string; httpStatus: number;
  duration: number; state: string; attempts: Attempt[];
  streamUsage: Record<string, unknown>; contents: { kind: string; sealed: string; state: string; expiresAt: string }[];
};

export function createAudit(db: ReturnType<typeof connectDatabase>, env = process.env) {
  const cipher = auditCipher(env);
  let lost = 0;
  const pending = new Set<Promise<void>>();
  const available = Array.from({ length: 4 }, () => Promise.resolve());
  let nextWriter = 0;
  const journal = env.MINATO_AUDIT_JOURNAL ? new Journal(env.MINATO_AUDIT_JOURNAL, { create: true }) : undefined;
  journal?.exec(`pragma journal_mode = WAL; pragma synchronous = full; pragma busy_timeout = 3000;
    create table if not exists audit_pending (id text primary key, payload text not null, retry_at integer not null)`);
  let recovering: Promise<void> | undefined;
  async function flush() { await Promise.allSettled([...pending, recovering]); }

  async function write(entry: AuditEntry) {
    const { id, environmentId, featureId, routeVersion, endpoint, kind, correlationId, startedAt,
      status, httpStatus, duration, state, attempts, streamUsage, contents } = entry;
    if (Date.parse(startedAt) < Date.now() - 90 * 86400000) return;
    const recordedState = contents.length && contents.every((content) => Date.parse(content.expiresAt) <= Date.now())
      ? "expired" : state;
    await db.begin(async (tx) => {
    await tx`insert into calls (request_id, environment_id, feature_id, route_version, kind, endpoint,
      capture_state, correlation_id, status, http_status, duration_ms, started_at)
      values (${id}, ${environmentId}, ${featureId}, ${routeVersion}::bigint, ${kind},
      ${endpoint}, ${recordedState}, ${correlationId}, ${status}, ${httpStatus}, ${Math.round(duration)}, ${startedAt})
      on conflict (request_id) do update set status = excluded.status, http_status = excluded.http_status,
        duration_ms = excluded.duration_ms,
        capture_state = case when calls.capture_state = 'expired' then 'expired' else excluded.capture_state end`;
    if (attempts.length) await tx`insert into call_attempts
      (id, request_id, source_id, model_id, http_status, duration_ms, retryable, captured_at, price_snapshot, error_code)
      select a.id, ${id}::uuid, a."sourceId", a."modelId", a.status, round(a."durationMs")::int, a.retryable,
        ${startedAt}::timestamptz + a.position * interval '1 microsecond', coalesce(m.capability_override, '{}'), a."errorCode"
      from jsonb_to_recordset(${JSON.stringify(attempts.map((entry, position) => ({ ...entry, position })))}::text::jsonb)
        a(id uuid, "sourceId" text, "modelId" text, status int, "durationMs" float8, retryable bool, position int, "errorCode" text)
      left join sources s on s.slug = a."sourceId" left join source_models m on m.source_id = s.id and m.raw_model_id = a."modelId"
      on conflict (id) do nothing`;
    for (const entry of attempts) {
      if (entry.usage) await saveUsage(tx, entry.id, entry.usage);
      if (Object.hasOwn(streamUsage, entry.id)) await saveUsage(tx, entry.id, streamUsage[entry.id]);
    }
    if (contents.length) await tx`insert into call_content (request_id, kind, sealed, capture_state, expires_at)
      select ${id}::uuid, content.kind, content.sealed, content.state, content."expiresAt"
      from jsonb_to_recordset(${JSON.stringify(contents)}::text::jsonb) content(kind text, sealed text, state text, "expiresAt" timestamptz)
      where content."expiresAt" > now() and exists (select 1 from calls c where c.request_id = ${id} and c.capture_state <> 'expired')
      on conflict (request_id, kind) do nothing`;
    if (Date.parse(startedAt) < Date.now() - 2 * 3600000) {
      await tx`update usage_hours set ready = false where environment_id = ${environmentId}
        and hour = date_trunc('hour', ${startedAt}::timestamptz, 'UTC')`;
    }
  });
  }

  function recover() {
    if (!journal) return;
    recovering ??= (async () => {
      const entries = journal.query<{ id: string; payload: string }, [number]>(
        "select id, payload from audit_pending where retry_at <= ? order by retry_at limit 100").all(Date.now());
      for (const entry of entries) {
        try {
          await write(JSON.parse(entry.payload));
          journal.query("delete from audit_pending where id = ?").run(entry.id);
        } catch (error) {
          console.error("Audit retry failed", entry.id, (error as { code?: string })?.code);
          journal.query("update audit_pending set retry_at = ? where id = ?").run(Date.now() + 60_000, entry.id);
        }
      }
    })().finally(() => { recovering = undefined; });
    return recovering;
  }

  function start(options: {
    id: string; environmentId: string; snapshot: Snapshot; endpoint: Endpoint; body: unknown;
    policy: AuditPolicy; kind?: "production" | "test" | "replay"; correlationId?: string;
  }) {
    const { id, environmentId, snapshot, endpoint, body, policy } = options;
    const startedAt = new Date();
    const contents: AuditEntry["contents"] = [];
    const attempts: Attempt[] = [];
    const streamUsage = new Map<string, unknown>();
    let completion: Promise<void> | undefined;
    const started = db`insert into calls (request_id, environment_id, feature_id, route_version, kind, endpoint,
      capture_state, correlation_id, started_at)
      values (${id}, ${environmentId}, ${snapshot.id}, ${snapshot.version}::bigint, ${options.kind ?? "production"},
        ${endpoint}, ${policy.enabled ? "pending" : "disabled"}, ${options.correlationId ?? null}, ${startedAt})
      on conflict (request_id) do nothing`.then(() => undefined, () => undefined);
    function protect(kind: string, value: unknown, partial = false) {
      if (!policy.enabled || !cipher) return;
      const recorded = capture(value, policy);
      contents.push({ kind, sealed: cipher.seal(recorded.text, `${id}:${kind}`),
        expiresAt: new Date(Date.now() + policy.retentionDays * 86400000).toISOString(),
        state: recorded.state === "truncated" ? "truncated" : partial ? "partial" : "captured" });
    }
    protect("request", body);

    return {
      started,
      record(attempt: Attempt) { attempts.push(attempt); },
      usage(attemptId: string, usage: unknown) { streamUsage.set(attemptId, usage); },
      finish(status: string, httpStatus: number, duration: number, response: unknown) {
        if (completion) return completion;
        protect("response", response, status === "interrupted");
        const writer = nextWriter++ % available.length;
        const state = policy.enabled ? cipher ? (status === "interrupted" ? "partial" : "captured") : "unavailable" : "disabled";
        const entry: AuditEntry = {
          id, environmentId, featureId: snapshot.id, routeVersion: snapshot.version, endpoint,
          kind: options.kind ?? "production", correlationId: options.correlationId ?? null, startedAt: startedAt.toISOString(),
          status, httpStatus, duration, state, contents, attempts,
          streamUsage: Object.fromEntries(streamUsage),
        };
        let journaled = false;
        if (journal) {
          try {
            journal.query("insert or replace into audit_pending (id,payload,retry_at) values (?,?,?)")
              .run(id, JSON.stringify(entry), Date.now() + 30_000);
            journaled = true;
          } catch (error) {
            console.error("Audit journal write failed", id, (error as { code?: string })?.code);
          }
        }
        const task = available[writer].then(async () => {
          await started;
          for (let retry = 0; retry < 3; retry++) {
            try {
              await write(entry);
              if (journaled) journal!.query("delete from audit_pending where id = ?").run(id);
              return;
            } catch (error) {
              if (retry === 2) throw error;
              await Bun.sleep(25 * (retry + 1));
            }
          }
        }).catch((error) => {
          if (!journaled) lost++;
          console.error("Audit transaction failed", id, (error as { code?: string })?.code);
        }).finally(() => pending.delete(task));
        available[writer] = task;
        pending.add(task);
        completion = task;
        return task;
      },
      streamLimit: policy.enabled && cipher ? policy.contentLimit : 0,
    };
  }
  return { start, flush, recover, close: () => journal?.close(), stats: () => ({
    queued: pending.size, lost,
    journalPending: journal?.query<{ count: number }, []>("select count(*) as count from audit_pending").get()?.count ?? 0,
  }) };
}

export function observeSse(stream: ReadableStream<Uint8Array>, endpoint: Endpoint, policy: AuditPolicy, captureLimit: number,
  finish: (state: string, detail: unknown, usage: unknown) => void | Promise<void>) {
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
    return finish(status, { format: "sse", events: captured, truncated }, usage);
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          await end(terminal && !failed ? "succeeded" : "interrupted");
          controller.close();
          return;
        }
        const frame = decoder.decode(result.value);
        if (["chat-completions", "completions", "image-generation", "image-edit"].includes(endpoint)) terminal ||= /(?:^|\n)data:\s*\[DONE\]/.test(frame);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
          try {
            const event = JSON.parse(line.slice(5));
            terminal ||= endpoint === "responses" && event.type === "response.completed";
            terminal ||= (endpoint === "anthropic-messages" && event.type === "message_stop") ||
              (endpoint === "transcription" && event.type === "transcript.text.done") ||
              (["image-generation", "image-edit"].includes(endpoint) && /\.completed$/.test(event.type ?? ""));
            if (endpoint === "anthropic-messages" && (event.usage || event.message?.usage)) {
              const counts = { ...(usage as object), ...(event.message?.usage ?? event.usage) } as { input_tokens?: number; output_tokens?: number };
              usage = { ...counts, ...(counts.input_tokens !== undefined && counts.output_tokens !== undefined
                ? { total_tokens: counts.input_tokens + counts.output_tokens } : {}) };
            } else usage = event.usage ?? event.response?.usage ?? usage;
            failed ||= !!event.error || ["error", "response.failed", "response.incomplete"].includes(event.type);
            if (!captureLimit || truncated) continue;
            const sanitized = capture(event, policy);
            const next = sanitized.text + "\n";
            truncated = sanitized.state === "truncated" || captured.length + next.length > captureLimit;
            if (!truncated) captured += next;
          } catch { /* malformed frames are not capturable */ }
        }
        controller.enqueue(result.value);
      } catch (error) {
        await end("interrupted");
        controller.error(error);
      }
    },
    cancel(reason) {
      void end("cancelled");
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}
