import type { connectDatabase } from "./client";
import { readUsage } from "./usage-report";

type Database = ReturnType<typeof connectDatabase>;
type Bucket = {
  status: string; latency: string | null; requests: string; fallbacks: string; attempts: string; unknown: string;
  tokens: string | null; input: string | null; output: string | null; cached: string | null; reasoning: string | null;
  priced: string; cost: string | null;
};
const hourMs = 3_600_000;
const keys = ["tokens", "input", "output", "cached", "reasoning"] as const;
function total(rows: Bucket[]) {
  const latency = new Map<number, number>();
  let count = 0;
  for (const row of rows) {
    if (row.latency === null) continue;
    const ms = Number(row.latency);
    const n = Number(row.requests);
    count += n;
    latency.set(ms, (latency.get(ms) ?? 0) + n);
  }
  const ordered = [...latency].sort(([a], [b]) => a - b);
  function percentile(n: number) {
    let remaining = Math.ceil(count * n);
    for (const [ms, hits] of ordered) {
      remaining -= hits;
      if (remaining <= 0) return ms;
    }
    return null;
  }
  const sum = (key: "requests" | "fallbacks" | "attempts" | "unknown" | "priced", subset = rows) =>
    subset.reduce((acc, row) => acc + Number(row[key]), 0);
  const counts = Object.fromEntries(keys.map((key) => [
    key, rows.reduce((acc, row) => acc + BigInt(row[key] ?? 0), 0n).toString(),
  ]));
  return {
    requestCount: sum("requests"), fallbackCount: sum("fallbacks"), attemptCount: sum("attempts"), unknownAttempts: sum("unknown"),
    succeededCount: sum("requests", rows.filter((row) => row.status === "succeeded")),
    errorCount: sum("requests", rows.filter((row) => ["failed","cancelled","interrupted"].includes(row.status))),
    knownTotalTokens: counts.tokens, inputTokens: counts.input, outputTokens: counts.output,
    cachedTokens: counts.cached, reasoningTokens: counts.reasoning, costKnownAttempts: sum("priced"),
    estimatedCostUsd: rows.reduce((acc, row) => acc + Number(row.cost ?? 0), 0).toFixed(8),
    p50Ms: percentile(0.5), p95Ms: percentile(0.95),
  };
}

export async function readHourlyUsage(db: Database, scope: string, from: string, to: string, project = false) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const scopes = await db`select e.id, first.started_at from environments e cross join lateral (
    select c.started_at from calls c where c.environment_id = e.id and c.started_at >= ${from}::timestamptz
      and c.started_at < ${to}::timestamptz order by c.started_at limit 1
  ) first where ${project ? db`e.project_id = ${scope}` : db`e.id = ${scope}`}`;
  if (!scopes.length) return;
  const firstHour = Math.min(...scopes.map(({ started_at }) => Math.floor(new Date(started_at).getTime() / hourMs))) * hourMs;
  const start = Math.max(Math.ceil(fromMs / hourMs) * hourMs, firstHour);
  const end = Math.min(Math.floor(toMs / hourMs) * hourMs, Math.floor(Date.now() / hourMs) * hourMs - 2 * hourMs);
  if (end <= start) return;
  const ranges = scopes.map(({ id, started_at }) => ({ id,
    start: Math.max(start, Math.floor(new Date(started_at).getTime() / hourMs) * hourMs) }))
    .filter((range) => range.start < end);
  const hours = await db`select h.hour, h.data from jsonb_to_recordset(${JSON.stringify(ranges)}::text::jsonb)
    as r(id uuid, start bigint) join usage_hours h on h.environment_id = r.id
      and h.hour >= to_timestamp(r.start / 1000) and h.hour < ${new Date(end)} where h.ready`;
  if (hours.length !== ranges.reduce((total, range) => total + (end - range.start) / hourMs, 0)) return;
  const daily = new Map<string, Bucket[]>();
  function add(date: string, rows: Bucket[]) {
    const day = date.slice(0, 10);
    let current = daily.get(day);
    if (!current) {
      current = [];
      daily.set(day, current);
    }
    for (const row of rows) current.push(row);
  }
  for (const bucket of hours) add(new Date(bucket.hour).toISOString(), bucket.data);
  for (const [left, right] of [[Math.max(fromMs, firstHour), start], [end, toMs]]) {
    for (let cursor = left; cursor < right;) {
      const boundary = Math.min(right, (Math.floor(cursor / 86400000) + 1) * 86400000);
      const date = new Date(cursor).toISOString();
      add(date, await readUsage(db, scope, { from: date, to: new Date(boundary).toISOString() },
        { bucket: true, project }) as Bucket[]);
      cursor = boundary;
    }
  }
  return {
    ...total([...daily.values()].flat()),
    costTrend: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
      const day = total(rows);
      return { date, requests: day.requestCount, errors: day.errorCount, fallbacks: day.fallbackCount, p95Ms: day.p95Ms,
        tokens: rows.some((row) => row.tokens !== null) ? day.knownTotalTokens : null, costKnownAttempts: day.costKnownAttempts,
        estimatedCostUsd: day.costKnownAttempts ? day.estimatedCostUsd : null };
    }).filter((day) => day.requests),
  };
}

export async function enqueueUsageHours(db: Database) {
  await db`insert into usage_hours (environment_id, hour)
    select e.id, h.hour from environments e cross join lateral generate_series(
    date_trunc('hour',(select c.started_at from calls c where c.environment_id = e.id
      and c.started_at >= now() - interval '31 days' order by c.started_at limit 1),'UTC'),
      date_trunc('hour',now(),'UTC') - interval '3 hours', interval '1 hour') h(hour)
    where e.archived_at is null on conflict do nothing`;
}

export async function buildUsageHour(db: Database) {
  return db.begin(async (tx) => {
    const [row] = await tx`select environment_id, hour from usage_hours where not ready order by hour desc
      limit 1 for update skip locked`;
    if (!row) return false;
    const start = new Date(row.hour);
    const data = await readUsage(tx as unknown as Database, row.environment_id, {
      from: start.toISOString(), to: new Date(start.getTime() + hourMs).toISOString(),
    }, { bucket: true });
    await tx`update usage_hours set ready = true, data = ${JSON.stringify(data, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value)}::text::jsonb where environment_id = ${row.environment_id} and hour = ${start}`;
    return true;
  });
}
