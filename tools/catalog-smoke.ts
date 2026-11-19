import assert from "node:assert/strict";
import { connectDatabase } from "../packages/db/client";
import { syncNextSource } from "../apps/worker/catalog";
import { reconcileNextFeature } from "../apps/worker/reconcile";
import { previewCandidates } from "../packages/db/routing-policy";

const db = connectDatabase();
const slug = "catalog-" + crypto.randomUUID().slice(0, 8);
let failure = false;
let incomplete = false;
let seen = ["Model A", "model-b"];
const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
  if (failure) return new Response(null, { status: 503 });
  return Response.json({ data: seen.map((id) => ({ id, context_window: id === "Model A" ? 64_000 : 32_000 })), has_more: incomplete });
} });
process.env.MINATO_UPSTREAM_CATALOG_SMOKE = "synthetic-token";
let sourceId: string | undefined;
let projectId: string | undefined;
let environmentId: string | undefined;
try {
  const [source] = await db`insert into sources (slug, kind, directory_url, api_base, credential_env, default_endpoint)
    values (${slug}, 'cpa', ${mock.url.href + "v1/models"}, ${mock.url.href + "v1"},
      'MINATO_UPSTREAM_CATALOG_SMOKE', 'responses') returning id`;
  sourceId = source.id;
  const [project] = await db`insert into projects (slug, display_name) values (${slug}, 'Catalog smoke') returning id`;
  projectId = project.id;
  const [environment] = await db`insert into environments (project_id, slug, display_name)
    values (${projectId}, 'production', 'Production') returning id`;
  environmentId = environment.id;
  const declaration = { displayName: "Catalog smoke", preferredModel: { sourceId: slug, modelId: "Model A" },
    requirements: { endpoint: "responses", minContextTokens: 24_000 } };
  const policy = { fallbacks: [{ sourceId: slug, modelId: "model-b" }] };
  const [feature] = await db`insert into features (environment_id, slug, alias, declaration, approved_policy)
    values (${environmentId}, 'classification', ${slug + ".production.classification"},
      ${JSON.stringify(declaration)}::text::jsonb, ${JSON.stringify(policy)}::text::jsonb) returning *`;
  const next = async () => {
    await db`update sources set next_sync_at = now() - interval '24 hours' where id = ${sourceId}`;
    assert(await syncNextSource(db));
  };
  const candidates = async () => (await previewCandidates(db, feature, policy)).candidates.map(({ modelId }) => modelId);
  await next();
  assert.deepEqual(await candidates(), ["Model A", "model-b"]);
  failure = true;
  await next();
  assert.deepEqual(await candidates(), ["Model A", "model-b"]);
  failure = false;
  incomplete = true;
  seen = [];
  await next();
  assert.deepEqual(await candidates(), ["Model A", "model-b"]);
  incomplete = false;
  await next();
  assert.deepEqual(await candidates(), ["Model A", "model-b"]);
  seen = ["model-b"];
  await next();
  assert.deepEqual(await candidates(), ["Model A", "model-b"]);
  await next();
  assert.deepEqual(await candidates(), ["model-b"]);
  assert(await reconcileNextFeature(db));
  const [queued] = await db`select r.candidates from route_versions r join features f
    on (f.id, f.desired_version) = (r.feature_id, r.version) where f.id = ${feature.id}`;
  assert.deepEqual(queued.candidates.map(({ modelId }: { modelId: string }) => modelId), ["model-b"]);
  await next();
  assert(await reconcileNextFeature(db));
  const [unchanged] = await db`select count(*)::int as count from route_versions where feature_id = ${feature.id}`;
  assert.equal(unchanged.count, 1);
  seen = [];
  await next();
  await next();
  assert(await reconcileNextFeature(db));
  const [unavailable] = await db`select unavailable from features where id = ${feature.id}`;
  assert.equal(unavailable.unavailable, true);
  seen = ["Model A", "model-b"];
  await next();
  assert.deepEqual(await candidates(), ["Model A", "model-b"]);
  console.log("Verified incomplete and failed snapshots, empty confirmation, removal, unchanged routes and recovery.");
} finally {
  mock.stop(true);
  await db.begin(async (tx) => {
    if (environmentId) {
      await tx`update features set desired_version = null where environment_id = ${environmentId}`;
      await tx`delete from route_versions where feature_id in (select id from features where environment_id = ${environmentId})`;
      await tx`delete from features where environment_id = ${environmentId}`;
      await tx`delete from environments where id = ${environmentId}`;
    }
    if (projectId) await tx`delete from projects where id = ${projectId}`;
    if (sourceId) {
      await tx`delete from source_syncs where source_id = ${sourceId}`;
      await tx`delete from source_models where source_id = ${sourceId}`;
      await tx`delete from sources where id = ${sourceId}`;
    }
  });
  await db.close();
}
