import assert from "node:assert/strict";
import { createControl } from "../apps/control/server";
import { createIngress } from "../apps/ingress/server";
import { publishNextRoute } from "../apps/worker/routes";
import { reconcileNextFeature } from "../apps/worker/reconcile";
import { createTestRunner } from "../apps/worker/tests";
import { connectDatabase } from "../packages/db/client";
import { createRuntime } from "../packages/runtime/client";

const models = ["preferred", "backup", "third", "fourth", "invalid", "embedding", "vendor/model"];
const requests: { model: string; session: string | null }[] = [];
const mock = Bun.serve({
  hostname: "0.0.0.0", port: 0,
  async fetch(request) {
    const { model, input, stream } = await request.json();
    const session = request.headers.get("x-opencode-session");
    requests.push({ model, session });
    if (model === "preferred") {
      return Response.json({ error: { message: "Model disallowed by the organization's data region policy" } }, { status: 400 });
    }
    if (input === "invalid fixture input") {
      return Response.json({ error: { code: "invalid_request_error" } }, { status: 400 });
    }
    if (!session) return Response.json({ error: { message: "session required" } }, { status: 400 });
    const response = { id: "resp_fixture", object: "response", model, status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
    if (stream) {
      return new Response("event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response }) + "\n\n",
        { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json(response);
  },
});
const base = `http://${process.env.MINATO_FIXTURE_UPSTREAM_HOST ?? "127.0.0.1"}:${mock.port}/v1`;
const local = `http://127.0.0.1:${mock.port}/v1`;
const env = { ...process.env, MINATO_DATA_PLANE: "runtime",
  MINATO_ADMIN_PASSWORD: "local-model-smoke-password", MINATO_KEY_PEPPER: "synthetic-fixture-pepper-long-enough",
  MINATO_AUDIT_SECRET: "synthetic-fixture-secret-long-enough", MINATO_COOKIE_SECURE: "false",
  MINATO_UPSTREAM_FIXTURE: "fixture-key", MINATO_LOG_LEVEL: "silent" };
const db = connectDatabase();
const control = createControl(connectDatabase(), env);
const ingress = createIngress(connectDatabase(), env);
const proxy = createRuntime(env);
try {
  const session = await control.inject({ method: "POST", url: "/admin/v1/session", payload: { password: env.MINATO_ADMIN_PASSWORD } });
  assert.equal(session.statusCode, 204, session.body);
  const cookie = String(session.headers["set-cookie"]).split(";")[0];
  const csrf = (await control.inject({ url: "/admin/v1/session", headers: { cookie } })).json().csrfToken;
  const headers = { cookie, "x-csrf-token": csrf };
  async function admin(method: "POST" | "GET" | "PUT" | "PATCH", path: string, status: number, payload?: object) {
    const response = await control.inject({ method, url: "/admin/v1" + path, headers: { ...headers,
      "idempotency-key": crypto.randomUUID() }, payload });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  }
  const settings = { kind: "opencode-go", directoryUrl: local + "/models", apiBase: local,
    credentialEnv: "MINATO_UPSTREAM_FIXTURE", defaultEndpoint: "responses" };
  const catalog = await admin("POST", "/sources", 201, { ...settings, slug: "opencode-fixture" });
  for (const model of models) {
    await db`insert into source_models(source_id,raw_model_id) values(${catalog.id},${model})`;
  }
  function modelRef(modelId: string) { return { sourceId: "opencode-fixture", modelId }; }
  await admin("PUT", `/sources/${catalog.id}/models/embedding`, 200, { upstreamEndpoint: "embeddings" });
  const denied = await admin("POST", `/sources/${catalog.id}/models/preferred/verify`, 200);
  assert.equal(denied.code, "model_region_unavailable");
  const verified = await admin("POST", `/sources/${catalog.id}/models/vendor%2Fmodel/verify`, 200);
  assert.equal(verified.code, null);
  const directory = await admin("GET", `/sources/${catalog.id}/models`, 200);
  assert.equal(directory.find(({ modelId }) => modelId === "vendor/model").verification.status, 200);
  await admin("PATCH", `/sources/${catalog.id}`, 200, { ...settings, apiBase: base, expectedRevision: catalog.revision });

  await admin("POST", "/projects", 201, { slug: "auto-route", displayName: "Fixture" });
  const environment = await admin("POST", "/projects/auto-route/environments", 201, { slug: "production", displayName: "Production" });
  const key = await admin("POST", "/projects/auto-route/environments/production/keys", 201, { label: "Fixture" });
  const scope = `/environments/${environment.id}`;
  await admin("PUT", scope + "/defaults", 200, { pool: ["backup", "third", "fourth"].map(modelRef) });
  await admin("PUT", scope + "/auto-publish", 200, { enabled: true });
  await admin("PUT", scope + "/audit-policy", 200,
    { enabled: true, retentionDays: 2, contentLimit: 8192, redactKeys: [], expectedRevision: 1 });
  const authorization = { authorization: `Bearer ${key.key}` };
  const registration = await control.inject({ method: "PUT",
    url: "/minato/v1/projects/auto-route/environments/production/features/classify", headers: authorization,
    payload: { displayName: "Classify", preferredModel: modelRef("preferred"), requirements: { endpoint: "responses" } } });
  assert.equal(registration.statusCode, 201, registration.body);
  const { alias } = registration.json();
  assert.equal(await reconcileNextFeature(db), true);
  assert.equal(await publishNextRoute(db, proxy), true);
  const [feature] = await admin("GET", scope + "/features", 200);
  assert.deepEqual(feature.activeModels.map(({ modelId }) => modelId), ["preferred", "backup", "third"]);
  const preview = await admin("POST", `/features/${feature.id}/routing/preview`, 200, {
    orderedModels: ["embedding", "backup", "third", "fourth", "preferred"].map(modelRef),
  });
  assert.deepEqual(preview.excluded.map(({ reason }) => reason), ["endpoint_mismatch", "candidate_limit"]);
  const production = await ingress.inject({ method: "POST", url: "/v1/responses",
    headers: { ...authorization, "x-opencode-session": "fixture-business" }, payload: { model: alias, input: "fixture" } });
  assert.equal(production.statusCode, 200, production.body);
  assert.equal(production.json().model, alias);
  const originalId = String(production.headers["x-request-id"]);
  const call = await admin("GET", `/calls/${originalId}`, 200);
  assert.deepEqual(call.attempts.map(({ model_id, total_tokens, error_code }) =>
    [model_id, total_tokens, error_code]), [["preferred", null, "model_region_unavailable"], ["backup", "5", null]]);
  const content = await admin("GET", `/calls/${originalId}/content`, 200);
  assert.equal(content.content.length, 2);
  const streamed = await ingress.inject({ method: "POST", url: "/v1/responses",
    headers: { ...authorization, "x-opencode-session": "fixture-stream" }, payload: { model: alias, input: "fixture", stream: true } });
  assert.equal(streamed.statusCode, 200, streamed.body);
  assert.ok(streamed.body.includes("response.completed"));
  const streamedCall = await admin("GET", `/calls/${streamed.headers["x-request-id"]}`, 200);
  assert.equal(streamedCall.status, "succeeded");
  assert.deepEqual(streamedCall.attempts.map(({ model_id, total_tokens }) => [model_id, total_tokens]),
    [["preferred", null], ["backup", "5"]]);
  const oldRequestCount = requests.length;
  const invalid = await ingress.inject({ method: "POST", url: "/v1/responses",
    headers: authorization, payload: { model: alias, input: "invalid fixture input" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "upstream_invalid_request");
  assert.deepEqual(requests.slice(oldRequestCount).map(({ model }) => model), ["preferred", "backup"]);
  const runTest = createTestRunner(db, proxy, env);
  for (const replayOf of [undefined, originalId]) {
    const queued = await admin("POST", scope + "/tests", 202, { featureId: feature.id, replayOf,
      endpoint: "responses", request: { input: "fixture" }, target: { mode: "active_route" } });
    assert.equal(await runTest(), true);
    const result = await admin("GET", `/tests/${queued.id}`, 200);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.output.actualModel, "backup");
    assert.deepEqual(result.attempts.map(({ modelId, status }) => [modelId, status]), [["preferred", 400], ["backup", 200]]);
    assert.equal(requests.at(-1)?.session, queued.id);
  }
  console.log("Catalog verification, preferred model publication, route preview, fallback, audit, test and replay passed.");
} finally {
  mock.stop(true);
  await Promise.allSettled([control.close(), ingress.close(), db.close()]);
}
