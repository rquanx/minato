import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit } from "../apps/ingress/audit";
import { searchCalls } from "../packages/db/call-search";
import { connectDatabase } from "../packages/db/client";
import { readUsage } from "../packages/db/usage-report";
import { buildUsageHour, enqueueUsageHours } from "../packages/db/usage-hours";

// Run only on a dedicated local benchmark database.
const rows = Number(process.env.MINATO_LOAD_CALLS ?? 300_000);
assert.ok(Number.isInteger(rows) && rows >= 100 && rows <= 10_000_000);
const db = connectDatabase();
const results: Record<string, number[]> = {};
async function measure<T>(name: string, work: () => Promise<T>) {
  const start = performance.now();
  const result = await work();
  (results[name] ??= []).push(performance.now() - start);
  return result;
}
const hourMs = 3_600_000;
const now = new Date();
const from = new Date(now.getTime() - 30 * 24 * hourMs).toISOString();
const to = now.toISOString();
const journalDir = await mkdtemp(join(tmpdir(), "minato-usage-load-"));
const journal = join(journalDir, "audit.sqlite");
const audit = createAudit(db, { MINATO_AUDIT_SECRET: "synthetic-load-secret-only-for-local-fixtures", MINATO_AUDIT_JOURNAL: journal });
try {
  const [project] = await db`insert into projects(slug,display_name) values ('usage-load','Usage load') returning id`;
  const [env] = await db`insert into environments(project_id,slug,display_name) values
    (${project.id},'fixture','Fixture') returning id`;
  const [feature] = await db`insert into features(environment_id,slug,alias,declaration)
    values(${env.id},'fixture','usage-load.fixture.fixture','{"displayName":"Fixture","requirements":{"endpoint":"responses"}}') returning id`;
  console.log(`Seeding ${rows} calls, 1.2 attempts per call, and 4 KiB bodies on 10% of calls.`);
  await db.begin(async (tx) => {
  await tx`create temporary table load_seed on commit drop as
    select gen_random_uuid() as id, n from generate_series(1,${rows}::integer) n`;
  await tx`insert into calls(request_id, environment_id, feature_id, route_version, endpoint, capture_state,
      kind, status, http_status, duration_ms, started_at)
    select id,${env.id}::uuid,${feature.id}::uuid,1,'responses',case when n%10=0 then 'captured' else 'disabled' end,
      'production',case when n%13=0 then 'failed' else 'succeeded' end,200,50+(n%6000),
      ${from}::timestamptz+((n-1)::float8/${rows}::int)*interval '30 days' from load_seed`;
  await tx`insert into call_attempts(id,request_id,source_id,model_id,http_status,duration_ms,price_snapshot)
    select gen_random_uuid(),id,'fixture-'||(n%3),'model-'||((n+a)%16),200,100,
      '{"inputPricePerMillion":1,"outputPricePerMillion":2}'
    from load_seed cross join lateral generate_series(1,case when n%5=0 then 2 else 1 end) a`;
  await tx`insert into attempt_usage(attempt_id,input_tokens,output_tokens,total_tokens)
    select id,n%80000,50,n%80000+50 from
    (select id,row_number() over () as n from call_attempts where request_id in (select id from load_seed)) a`;
  await tx`insert into call_content(request_id,kind,sealed,capture_state,expires_at)
    select id,kind,payload,'captured',now()+interval '7 days' from load_seed
    cross join (values ('request'),('response')) part(kind)
    cross join (select string_agg(md5(n::text),'') as payload from generate_series(1,128) n) sample where n%10=0`;
  });
  await db`analyze`;
  const [second] = await db`insert into environments(project_id,slug,display_name) values
    (${project.id},'second','Second fixture') returning id`;
  const [secondFeature] = await db`insert into features(environment_id,slug,alias,declaration)
    values(${second.id},'fixture','usage-load.second.fixture','{"displayName":"Fixture","requirements":{"endpoint":"responses"}}') returning id`;
  await db`insert into calls (request_id, environment_id, feature_id, route_version, endpoint, capture_state, status, duration_ms, started_at)
    values(gen_random_uuid(),${second.id},${secondFeature.id},1,'responses','disabled','succeeded',800,${to}::timestamptz - interval '4 days')`;

  const queries = {
    "Calls recent": () => searchCalls(db, env.id, { limit: 50 }),
    "Calls by minimum tokens": () => searchCalls(db, env.id, { limit: 50, from, to, minTokens: 120_000 }),
    "Usage by model": () => readUsage(db, env.id, { from, to, group: "model" }),
    "Project month trend": () => readUsage(db, project.id, { from, to }, { project: true }),
  };
  for (const [name, query] of Object.entries(queries)) {
    await query();
    for (let index = 0; index < 8; index++) await measure(name, query);
  }
  const expected = await readUsage(db, env.id, { from, to });
  const expectedProject = await queries["Project month trend"]();
  await enqueueUsageHours(db);
  await measure("Build hourly summaries", async () => { while (await buildUsageHour(db)) {} });
  for (let index = 0; index < 8; index++) {
    const summarized = await measure("Environment month trend", () => readUsage(db, env.id, { from, to }));
    assert.equal(summarized.requestCount, expected.requestCount);
    assert.equal(summarized.knownTotalTokens, expected.knownTotalTokens);
    const projectSummary = await measure("Project month trend with hourly summaries", queries["Project month trend"]);
    assert.equal(projectSummary.requestCount, expectedProject.requestCount);
    assert.equal(projectSummary.knownTotalTokens, expectedProject.knownTotalTokens);
    assert.equal(projectSummary.estimatedCostUsd, expectedProject.estimatedCostUsd);
  }
  const policy = { enabled: true, retentionDays: 7, contentLimit: 8192, redactKeys: [] };
  const content = Buffer.from(crypto.getRandomValues(new Uint8Array(3000))).toString("base64");
  const start = performance.now();
  await Promise.all([
    ...Array.from({ length: 8 }, async () => {
      for (let index = 0; index < 25; index++) await measure("Audit write with concurrent reads", async () => {
        const call = audit.start({ id: crypto.randomUUID(), environmentId: env.id, snapshot: { id: feature.id, version: "1" },
          endpoint: "responses", body: { input: content }, policy });
        await call.started;
        call.record({ id: crypto.randomUUID(), sourceId: "fixture", modelId: "model-1", status: 200,
          durationMs: 170, retryable: false, usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } });
        await call.finish("succeeded", 200, 170, { output: content });
      });
    }),
    ...Object.entries(queries).map(async ([name, query]) => {
      for (let index = 0; index < 4; index++) await measure(name + " with concurrent writes", query);
    }),
  ]);
  assert.equal(audit.stats().lost, 0);
  assert.equal(audit.stats().journalPending, 0);
  console.log(`Mixed read/write elapsed ${Math.round(performance.now() - start)} ms`);
  for (const [name, samples] of Object.entries(results)) {
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    console.log(`${name}: p95 ${p95.toFixed(1)} ms (${samples.length} samples)`);
  }
  console.table(await db`select relname as table, pg_total_relation_size(oid)::int8::text as bytes from pg_class
    where relname in ('calls','call_attempts','attempt_usage','call_content','usage_hours') order by relname`);
} finally {
  await audit.flush();
  audit.close();
  await db.close();
  for (const file of [journal, journal + "-wal", journal + "-shm"]) {
    await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  await rmdir(journalDir);
}
