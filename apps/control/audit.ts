import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, uuid } from "../../packages/contracts";
import { auditCipher, auditPolicy } from "../../packages/db/audit";
import { saveUsage } from "../../packages/db/usage";
import type { Database } from "./auth";

const idPath = z.object({ id: uuid });
const list = z.object({
  before: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  featureId: uuid.optional(), kind: z.enum(["production", "test", "replay"]).optional(),
  status: z.string().optional(), source: z.string().max(160).optional(), model: z.string().max(256).optional(),
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
});
const cursor = z.tuple([z.iso.datetime({ offset: true }), uuid]);

export function registerUsageCallback(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  app.post("/internal/v1/litellm/usage", async (request, reply) => {
    const secret = env.MINATO_CALLBACK_SECRET;
    if (!secret || secret.length < 32 || !timingSafeEqual(
      digest(request.headers.authorization ?? ""), digest(`Bearer ${secret}`),
    )) throw new ApiError(401, "invalid_callback_token", "Invalid callback token");
    const input = z.strictObject({ attemptId: uuid, usage: z.unknown() }).parse(request.body);
    await saveUsage(db, input.attemptId, input.usage);
    return reply.code(204).send();
  });
}

export function registerAudit(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv) {
  const cipher = auditCipher(env);
  app.get("/admin/v1/environments/:id/audit-policy", async (request) => {
    const { id } = idPath.parse(request.params);
    const [row] = await db`select audit_enabled as enabled, audit_days as "retentionDays",
      audit_limit as "contentLimit", audit_redact as "redactKeys", settings_revision as revision
      from environments where id = ${id}`;
    if (!row) throw new ApiError(404, "environment_not_found", "Environment not found");
    return row;
  });
  app.put("/admin/v1/environments/:id/audit-policy", async (request) => {
    const { id } = idPath.parse(request.params);
    const input = auditPolicy.extend({ expectedRevision: z.number().int().nonnegative() }).parse(request.body);
    if (input.enabled && !cipher) throw new ApiError(422, "audit_key_required", "Configure MINATO_AUDIT_SECRET first");
    return db.begin(async (tx) => {
      const [updated] = await tx`update environments set audit_enabled = ${input.enabled}, audit_days = ${input.retentionDays},
        audit_limit = ${input.contentLimit}, audit_redact = ${JSON.stringify(input.redactKeys)}::text::jsonb,
        settings_revision = settings_revision + 1 where id = ${id} and settings_revision = ${input.expectedRevision}
        returning settings_revision as revision`;
      if (!updated) throw new ApiError(409, "stale_audit_policy", "Audit policy has changed");
      await tx`insert into admin_events (actor, action, entity_id) values ('admin', 'audit.policy_changed', ${id})`;
      return updated;
    });
  });
  app.get("/admin/v1/environments/:id/calls", async (request) => {
    const { id } = idPath.parse(request.params);
    const input = list.parse(request.query);
    let position: [string, string] | undefined;
    if (input.before) {
      try { position = cursor.parse(JSON.parse(Buffer.from(input.before, "base64url").toString())); }
      catch { throw new ApiError(422, "invalid_cursor", "Invalid page cursor"); }
    }
    const rows = await db`select c.request_id as "requestId", c.status, c.kind,
      c.capture_state as "captureState", c.started_at as "startedAt", c.duration_ms as "durationMs",
      to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorTime",
      f.alias, (select sum(u.total_tokens)::text from call_attempts a
        join attempt_usage u on u.attempt_id = a.id where a.request_id = c.request_id) as "totalTokens"
      from calls c join features f on f.id = c.feature_id
      where c.environment_id = ${id} and (${input.featureId ?? null}::uuid is null or c.feature_id = ${input.featureId ?? null})
      and (${input.kind ?? null}::text is null or c.kind = ${input.kind ?? null})
      and (${input.status ?? null}::text is null or c.status = ${input.status ?? null})
      and (${input.from ?? null}::timestamptz is null or c.started_at >= ${input.from ?? null})
      and (${input.to ?? null}::timestamptz is null or c.started_at < ${input.to ?? null})
      and (${position?.[0] ?? null}::timestamptz is null or
        (c.started_at, c.request_id) < (${position?.[0] ?? null}::timestamptz, ${position?.[1] ?? null}::uuid))
      and ((${input.source ?? null}::text is null and ${input.model ?? null}::text is null) or exists (
        select 1 from call_attempts a where a.request_id = c.request_id
        and (${input.source ?? null}::text is null or a.source_id = ${input.source ?? null})
        and (${input.model ?? null}::text is null or a.model_id = ${input.model ?? null})))
      order by c.started_at desc, c.request_id desc limit ${input.limit + 1}`;
    const page = rows.slice(0, input.limit);
    const tail = page.at(-1);
    return { items: page.map(({ cursorTime: _position, ...row }) => row), before: rows.length > input.limit && tail
      ? Buffer.from(JSON.stringify([tail.cursorTime, tail.requestId])).toString("base64url") : null };
  });
  app.get("/admin/v1/calls/:id", async (request) => {
    const { id } = idPath.parse(request.params);
    const [call] = await db`select c.*, f.alias from calls c join features f on c.feature_id = f.id where request_id = ${id}`;
    if (!call) throw new ApiError(404, "call_not_found", "Call not found");
    const attempts = await db`select a.*, u.input_tokens::text, u.output_tokens::text, u.total_tokens::text,
      u.cached_tokens::text, u.reasoning_tokens::text from call_attempts a left join attempt_usage u on a.id = u.attempt_id
      where a.request_id = ${id} order by a.captured_at, a.id`;
    return { ...call, attempts };
  });
  app.get("/admin/v1/calls/:id/content", async (request, reply) => {
    const { id } = idPath.parse(request.params);
    const [call] = await db`select capture_state from calls where request_id = ${id}`;
    if (!call) throw new ApiError(404, "call_not_found", "Call not found");
    const details = await db`select kind, sealed, capture_state from call_content where request_id = ${id} and expires_at > now()`;
    const content = details.map((part) => ({
      kind: part.kind, state: cipher ? part.capture_state : "unavailable",
      value: cipher ? JSON.parse(cipher.open(part.sealed, `${id}:${part.kind}`)) : null,
    }));
    await db`insert into admin_events (actor, action, entity_id) values ('admin', 'audit.content_read', ${id})`;
    return reply.header("Cache-Control", "no-store").send({ state: call.capture_state, content });
  });
  app.delete("/admin/v1/calls/:id/content", async (request, reply) => {
    const { id } = idPath.parse(request.params);
    await db.begin(async (tx) => {
      const [call] = await tx`update calls set capture_state = 'expired' where request_id = ${id} returning request_id`;
      if (!call) throw new ApiError(404, "call_not_found", "Call not found");
      await tx`delete from call_content where request_id = ${id}`;
      await tx`insert into admin_events (actor, action, entity_id) values ('admin', 'audit.content_deleted', ${id})`;
    });
    return reply.code(204).send();
  });
  app.get("/admin/v1/environments/:id/usage", async (request) => {
    const { id } = idPath.parse(request.params);
    const range = list.parse(request.query);
    const [totals] = await db`with period as (
      select request_id from calls where environment_id = ${id}
      and started_at >= coalesce(${range.from ?? null}::timestamptz, now() - interval '7 days')
      and started_at < coalesce(${range.to ?? null}::timestamptz, now())
      and (${range.featureId ?? null}::uuid is null or feature_id = ${range.featureId ?? null})
      and (${range.kind ?? null}::text is null or kind = ${range.kind ?? null})
    )
    select (select count(*)::int from period) as "requestCount", count(a.id)::int as "attemptCount",
      count(a.id) filter(where u.total_tokens is null)::int as "unknownAttempts",
      coalesce(sum(u.total_tokens), 0)::text as "knownTotalTokens",
      coalesce(sum(u.input_tokens), 0)::text as "inputTokens", coalesce(sum(u.output_tokens), 0)::text as "outputTokens"
    from period p join call_attempts a on p.request_id = a.request_id left join attempt_usage u on a.id = u.attempt_id`;
    const [cost] = await db`with period as (
      select request_id, (started_at at time zone 'UTC')::date as day from calls where environment_id = ${id}
      and started_at >= coalesce(${range.from ?? null}::timestamptz, now() - interval '7 days')
      and started_at < coalesce(${range.to ?? null}::timestamptz, now())
      and (${range.featureId ?? null}::uuid is null or feature_id = ${range.featureId ?? null})
      and (${range.kind ?? null}::text is null or kind = ${range.kind ?? null})
    ), priced as (
      select p.day, u.input_tokens, u.output_tokens,
        case when coalesce(m.capability_override->>'priceCurrency', 'USD') = 'USD'
          and (m.capability_override->>'inputPricePerMillion') ~ '^[0-9]+(\\.[0-9]+)?$'
          then (m.capability_override->>'inputPricePerMillion')::numeric end as input_price,
        case when coalesce(m.capability_override->>'priceCurrency', 'USD') = 'USD'
          and (m.capability_override->>'outputPricePerMillion') ~ '^[0-9]+(\\.[0-9]+)?$'
          then (m.capability_override->>'outputPricePerMillion')::numeric end as output_price
      from period p join call_attempts a on p.request_id = a.request_id
      left join attempt_usage u on a.id = u.attempt_id
      left join sources s on s.slug = a.source_id
      left join source_models m on m.source_id = s.id and m.raw_model_id = a.model_id
    ), daily as (
      select day, count(*) filter (where input_price is not null and output_price is not null
        and input_tokens is not null and output_tokens is not null)::int as known,
        sum(input_tokens * input_price / 1000000 + output_tokens * output_price / 1000000) as estimated
      from priced group by day
    )
    select coalesce(sum(known), 0)::int as "costKnownAttempts",
      coalesce(sum(estimated), 0)::numeric(20,8)::text as "estimatedCostUsd",
      coalesce(jsonb_agg(jsonb_build_object('date', day, 'costKnownAttempts', known,
        'estimatedCostUsd', estimated::numeric(20,8)::text) order by day), '[]'::jsonb) as "costTrend"
    from daily`;
    return { ...totals, ...cost };
  });
}
