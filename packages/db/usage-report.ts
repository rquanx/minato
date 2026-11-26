import { z } from "zod";
import { ApiError } from "../contracts";
import { callRange } from "./call-search";
import type { connectDatabase } from "./client";

export const usageRange = callRange.extend({ group: z.enum(["model", "source", "feature", "endpoint"]).optional() });

export async function readUsage(db: ReturnType<typeof connectDatabase>, environment: string, input: z.infer<typeof usageRange>,
  options: { project?: boolean; bucket?: boolean } = {}) {
  const to = input.to ?? new Date().toISOString();
  const from = input.from ?? new Date(Date.parse(to) - 7 * 86400000).toISOString();
  if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 31 * 86400000) {
    throw new ApiError(422, "invalid_usage_range", "Choose a date range of up to 31 days");
  }
  const params: unknown[] = [environment, from, to];
  const filter = [options.project ? "c.environment_id in (select id from environments where project_id = $1)" : "c.environment_id = $1",
    "c.started_at >= $2::timestamptz", "c.started_at < $3::timestamptz"];
  if (input.featureId) filter.push(`c.feature_id = $${params.push(input.featureId)}::uuid`);
  if (input.kind) filter.push(`c.kind = $${params.push(input.kind)}`);
  const facts = `with period as (
    select c.request_id, c.feature_id, c.kind, c.endpoint, c.status, c.duration_ms, (c.started_at at time zone 'UTC')::date as day
    from calls c where ${filter.join(" and ")}
  ), prices as (
    select s.slug as source_id, m.raw_model_id as model_id,
      (m.capability_override->>'inputPricePerMillion')::numeric as input_price,
      (m.capability_override->>'outputPricePerMillion')::numeric as output_price,
      (m.capability_override->>'cachedInputPricePerMillion')::numeric as cached_price
    from source_models m join sources s on s.id = m.source_id
    where coalesce(m.capability_override->>'priceCurrency','USD') = 'USD'
      and jsonb_typeof(m.capability_override->'inputPricePerMillion') = 'number'
      and jsonb_typeof(m.capability_override->'outputPricePerMillion') = 'number'
  ), attempts as (
    select p.*, a.id, a.source_id, a.model_id, u.input_tokens, u.output_tokens, u.cached_tokens, u.reasoning_tokens, u.total_tokens,
      (u.input_tokens * price.input_price + u.output_tokens * price.output_price -
        least(u.input_tokens, coalesce(u.cached_tokens, 0)) * (price.input_price - coalesce(price.cached_price, price.input_price))) / 1000000 as cost
    from period p left join call_attempts a on a.request_id = p.request_id
    left join attempt_usage u on u.attempt_id = a.id
    left join prices live on a.price_snapshot is null and (live.source_id, live.model_id) = (a.source_id, a.model_id)
    cross join lateral (select
      case when a.price_snapshot is null then live.input_price when coalesce(a.price_snapshot->>'priceCurrency','USD') = 'USD'
        then (a.price_snapshot->>'inputPricePerMillion')::numeric end as input_price,
      case when a.price_snapshot is null then live.output_price when coalesce(a.price_snapshot->>'priceCurrency','USD') = 'USD'
        then (a.price_snapshot->>'outputPricePerMillion')::numeric end as output_price,
      case when a.price_snapshot is null then live.cached_price when coalesce(a.price_snapshot->>'priceCurrency','USD') = 'USD'
        then (a.price_snapshot->>'cachedInputPricePerMillion')::numeric end as cached_price
    ) price
  )`;
  if (input.group) {
    const labels = {
      model: ["a.source_id", "a.model_id"], source: ["a.source_id", "null::text"],
      feature: ["f.alias", "null::text"], endpoint: ["a.endpoint", "null::text"],
    };
    const [label, detail] = labels[input.group];
    const groups = await db.unsafe(`${facts}
      select ${label} as label, ${detail} as detail, count(distinct a.request_id)::float8 as requests,
        count(a.id)::float8 as attempts, coalesce(sum(a.total_tokens),0)::text as tokens,
        sum(a.cost)::numeric(25,8)::text as "estimatedCostUsd"
      from attempts a ${input.group === "feature" ? "join features f on f.id = a.feature_id" : ""}
      where ${label} is not null group by 1,2 order by sum(a.total_tokens) desc nulls last, count(*) desc, 1,2 limit 100`, params);
    return { groups };
  }
  const perCall = `per_call as (
    select day, request_id, status, duration_ms, count(id) as attempts, count(id) filter (where total_tokens is null) as unknown,
      sum(total_tokens) as tokens, sum(input_tokens) as input, sum(output_tokens) as output, sum(cached_tokens) as cached,
      sum(reasoning_tokens) as reasoning, count(cost) as priced, sum(cost) as cost
    from attempts group by day, request_id, status, duration_ms
  )`;
  if (options.bucket) return db.unsafe(`${facts}, ${perCall}
    select status, case when duration_ms is not null then (duration_ms::bigint / 50) * 50 + 49 end as latency,
      count(*) as requests, count(*) filter(where attempts > 1) as fallbacks,
      sum(attempts) as attempts, sum(unknown) as unknown, sum(tokens) as tokens,
      sum(input) as input, sum(output) as output, sum(cached) as cached, sum(reasoning) as reasoning,
      sum(priced) as priced, sum(cost) as cost
    from per_call group by 1,2`, params);
  if (!input.featureId && !input.kind && Date.parse(to) - Date.parse(from) >= 2 * 86400000) {
    const { readHourlyUsage } = await import("./usage-hours");
    const rollup = await readHourlyUsage(db, environment, from, to, options.project);
    if (rollup) return rollup;
  }
  const [totals] = await db.unsafe(`${facts}, ${perCall}, summaries as (
    select day, count(*)::float8 as requests, count(*) filter(where status = 'succeeded')::float8 as succeeded,
      count(*) filter(where status in ('failed','cancelled','interrupted'))::float8 as errors,
      count(*) filter(where attempts > 1)::float8 as fallbacks,
      coalesce(sum(attempts),0)::float8 as attempts, coalesce(sum(unknown),0)::float8 as unknown,
      sum(tokens)::text as tokens, coalesce(sum(input),0)::text as input, coalesce(sum(output),0)::text as output,
      coalesce(sum(cached),0)::text as cached, coalesce(sum(reasoning),0)::text as reasoning,
      coalesce(sum(priced),0)::float8 as priced, sum(cost)::numeric(25,8)::text as cost,
      percentile_disc(0.5) within group (order by duration_ms) as p50,
      percentile_disc(0.95) within group (order by duration_ms) as p95
    from per_call group by grouping sets ((day), ())
  )
  select requests as "requestCount", succeeded as "succeededCount", errors as "errorCount", fallbacks as "fallbackCount",
    attempts as "attemptCount", unknown as "unknownAttempts", coalesce(tokens,'0') as "knownTotalTokens",
    input as "inputTokens", output as "outputTokens", cached as "cachedTokens", reasoning as "reasoningTokens",
    p50 as "p50Ms", p95 as "p95Ms", priced as "costKnownAttempts", coalesce(cost,'0') as "estimatedCostUsd",
    (select coalesce(jsonb_agg(jsonb_build_object('date', day, 'requests', requests, 'tokens', tokens,
      'errors', errors, 'fallbacks', fallbacks, 'p95Ms', p95, 'costKnownAttempts', priced,
      'estimatedCostUsd', cost) order by day), '[]'::jsonb) from summaries where day is not null) as "costTrend"
  from summaries where day is null`, params);
  return totals;
}
