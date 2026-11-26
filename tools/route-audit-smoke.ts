import assert from "node:assert/strict";
import {connectDatabase} from "../packages/db/client";
import {createAudit} from "../apps/ingress/audit";
import {readUsage} from "../packages/db/usage-report";
import {enqueueUsageHours,buildUsageHour} from "../packages/db/usage-hours";
import {reconcileNextFeature} from "../apps/worker/reconcile";
import {publishNextRoute} from "../apps/worker/routes";
const db=connectDatabase();
try {
const [p]=await db`insert into projects(slug,display_name) values ('fixture','Fixture') returning id`;
const [e]=await db`insert into environments(project_id,slug,display_name) values (${p.id},'test','Test') returning id`;
const [s]=await db`insert into sources(slug,kind,directory_url,api_base,credential_env,default_endpoint)
values('fixture','openai','http://fixture/models','http://fixture/v1','MINATO_UPSTREAM_FIXTURE','responses') returning id`;
await db`insert into source_models(source_id,raw_model_id,capability_override) values
(${s.id},'old','{"inputPricePerMillion":1,"outputPricePerMillion":2}'),(${s.id},'new','{"inputPricePerMillion":1,"outputPricePerMillion":2}')`;
const policy=(modelId)=>JSON.stringify({orderedModels:[{sourceId:"fixture",modelId}]});
const candidates=(modelId)=>JSON.stringify([{sourceId:"fixture",modelId,apiBase:"http://fixture/v1",credentialEnv:"MINATO_UPSTREAM_FIXTURE",upstreamEndpoint:"responses"}]);
const [f]=await db`insert into features(environment_id,slug,alias,declaration,approved_policy,reconcile_needed)
values(${e.id},'test','fixture.test.test','{"displayName":"Test","requirements":{"endpoint":"responses"}}',${policy("old")}::text::jsonb,true) returning id`;
await db`insert into route_versions(feature_id,version,state,candidates,requirements,approved_policy) values
(${f.id},1,'active',${candidates("old")}::text::jsonb,'{"endpoint":"responses"}',${policy("old")}::text::jsonb),
(${f.id},2,'queued',${candidates("new")}::text::jsonb,'{"endpoint":"responses"}',${policy("new")}::text::jsonb)`;
await db`update features set active_version=1,desired_version=2 where id=${f.id}`;
assert.equal(await reconcileNextFeature(db),false);
await publishNextRoute(db,{publish:async()=>{}});
assert.equal(await reconcileNextFeature(db),true);
const [active]=await db`select active_version::int as version from features where id=${f.id}`;
assert.equal(active.version,2);
console.log("Manual publication survives a pending reconciliation.");
const audit=createAudit(db,{MINATO_AUDIT_SECRET:"synthetic-fixture-secret-long-enough"});
const id=crypto.randomUUID();
const a=audit.start({id,environmentId:e.id,snapshot:{id:f.id,version:"2"},endpoint:"responses",body:{input:"Example"},
policy:{enabled:true,retentionDays:7,contentLimit:4096,redactKeys:[]}});
await a.started;
a.record({id:crypto.randomUUID(),sourceId:"fixture",modelId:"new",status:200,durationMs:73,retryable:false,
usage:{input_tokens:4,output_tokens:3,total_tokens:7}});
await a.finish("succeeded",200,73,{text:"Example"});
assert.equal(audit.stats().lost,0);
const [meta]=await db`select status from calls where request_id=${id}`;
assert.equal(meta.status,"succeeded");
assert.equal((await db`select count(*)::int as n from call_content where request_id=${id}`)[0].n,2);
await db`update source_models set capability_override='{"inputPricePerMillion":10,"outputPricePerMillion":20}' where source_id=${s.id}`;
await db`update calls set started_at = now()-interval '8 hours' where request_id=${id}`;
const raw=await readUsage(db,e.id,{});
assert.equal(raw.estimatedCostUsd,"0.00001000");
await enqueueUsageHours(db); while(await buildUsageHour(db)){}
const summarized=await readUsage(db,e.id,{});
assert.equal(summarized.knownTotalTokens,"7"); assert.equal(summarized.requestCount,1);
assert.equal(summarized.p95Ms,99); assert.equal(summarized.estimatedCostUsd,raw.estimatedCostUsd);
const project=await readUsage(db,p.id,{}, {project:true});assert.equal(project.requestCount,1);
console.log("Audit, immutable pricing, hourly histogram, and project totals passed.");
} finally { await db.close(); }
