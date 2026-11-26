import { z } from "zod";
import { ApiError, endpoint, uuid } from "../contracts";
import type { connectDatabase } from "./client";

export const callRange = z.object({
  featureId: uuid.optional(), kind: z.enum(["production", "test", "replay"]).optional(),
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
});

export const callSearch = callRange.extend({
  before: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().max(40).optional(), source: z.string().trim().min(1).max(160).optional(), model: z.string().trim().min(1).max(256).optional(),
  requestId: uuid.optional(), correlationId: z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/).optional(),
  endpoint: endpoint.optional(), httpStatus: z.coerce.number().int().min(100).max(599).optional(),
  minDurationMs: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  minTokens: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  fallback: z.enum(["true", "false"]).optional(),
  capture: z.enum(["captured", "partial", "expired", "disabled", "pending", "unavailable"]).optional(),
});
const cursor = z.tuple([z.iso.datetime({ offset: true }), uuid]);

export async function searchCalls(db: ReturnType<typeof connectDatabase>, environment: string, input: z.infer<typeof callSearch>) {
  const values: unknown[] = [environment];
  const params = (value: unknown) => `$${values.push(value)}`;
  const where = ["c.environment_id = $1"];
  if (input.requestId) where.push(`c.request_id = ${params(input.requestId)}::uuid`);
  if (input.correlationId) where.push(`c.correlation_id = ${params(input.correlationId)}`);
  if (input.featureId) where.push(`c.feature_id = ${params(input.featureId)}::uuid`);
  if (input.kind) where.push(`c.kind = ${params(input.kind)}`);
  if (input.status === "errors") where.push("c.status in ('failed', 'interrupted', 'cancelled')");
  else if (input.status) where.push(`c.status = ${params(input.status)}`);
  if (input.endpoint) where.push(`c.endpoint = ${params(input.endpoint)}`);
  if (input.httpStatus !== undefined) where.push(`c.http_status = ${params(input.httpStatus)}`);
  if (input.minDurationMs !== undefined) where.push(`c.duration_ms >= ${params(input.minDurationMs)}`);
  if (input.capture) where.push(`c.capture_state = ${params(input.capture)}`);
  if (input.from) where.push(`c.started_at >= ${params(input.from)}::timestamptz`);
  else if (!input.requestId && !input.correlationId) where.push("c.started_at >= now() - interval '7 days'");
  if (input.to) where.push(`c.started_at < ${params(input.to)}::timestamptz`);
  if (input.before) {
    try {
      const [time, id] = cursor.parse(JSON.parse(Buffer.from(input.before, "base64url").toString()));
      where.push(`(c.started_at, c.request_id) < (${params(time)}::timestamptz, ${params(id)}::uuid)`);
    } catch { throw new ApiError(422, "invalid_cursor", "Invalid page cursor"); }
  }
  if (input.source || input.model) {
    const match = ["a.request_id = c.request_id"];
    if (input.source) match.push(`a.source_id = ${params(input.source)}`);
    if (input.model) match.push(`a.model_id = ${params(input.model)}`);
    where.push(`exists (select 1 from call_attempts a where ${match.join(" and ")})`);
  }
  if (input.fallback) where.push(`${input.fallback === "false" ? "not " : ""}exists (
    select 1 from call_attempts a where a.request_id = c.request_id offset 1)`);
  if (input.minTokens !== undefined) where.push(`(select sum(u.total_tokens) from call_attempts a
    join attempt_usage u on u.attempt_id = a.id where a.request_id = c.request_id) >= ${params(input.minTokens)}::numeric`);

  const rows = await db.unsafe(`with page as materialized (
    select c.* from calls c where ${where.join(" and ")}
    order by c.started_at desc, c.request_id desc limit ${params(input.limit + 1)}
  )
  select c.request_id as "requestId", c.correlation_id as "correlationId", c.status, c.kind, c.endpoint,
    c.capture_state as "captureState", c.started_at as "startedAt", c.duration_ms as "durationMs", c.http_status as "httpStatus",
    to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorTime",
    f.alias, a."totalTokens", a."attemptCount", a."modelId", a."sourceId"
  from page c join features f on f.id = c.feature_id
  left join lateral (
    select count(*)::int as "attemptCount", sum(u.total_tokens)::text as "totalTokens",
      (array_agg(t.model_id order by (t.http_status between 200 and 299) desc nulls last, t.captured_at desc, t.id desc))[1] as "modelId",
      (array_agg(t.source_id order by (t.http_status between 200 and 299) desc nulls last, t.captured_at desc, t.id desc))[1] as "sourceId"
    from call_attempts t left join attempt_usage u on u.attempt_id = t.id
    where t.request_id = c.request_id
  ) a on true order by c.started_at desc, c.request_id desc`, values);
  const page = rows.slice(0, input.limit);
  const tail = page.at(-1);
  return { items: page.map(({ cursorTime: _position, ...row }) => row), before: rows.length > input.limit && tail
    ? Buffer.from(JSON.stringify([tail.cursorTime, tail.requestId])).toString("base64url") : null };
}
