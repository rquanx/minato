import assert from "node:assert/strict";
import OpenAI from "openai";
import { createControl } from "../apps/control/server";
import { createIngress } from "../apps/ingress/server";
import { connectDatabase } from "../packages/db/client";
import { createLiteLlm } from "../packages/litellm/client";
import { createRuntime } from "../packages/runtime/client";
import { publishNextRoute } from "../apps/worker/routes";
import { createTestRunner } from "../apps/worker/tests";
import { cleanExpired } from "../apps/worker/tests";

const config = { ...process.env, MINATO_ADMIN_PASSWORD: "local-smoke-password",
  MINATO_KEY_PEPPER: "minato-smoke-key-pepper-keep-only-in-test", MINATO_COOKIE_SECURE: "false",
  MINATO_AUDIT_SECRET: "minato-smoke-audit-secret-keep-only-in-test",
  MINATO_CALLBACK_SECRET: "minato-smoke-callback-secret-for-testing",
  LITELLM_MASTER_KEY: "sk-minato-fixture", MINATO_UPSTREAM_FIXTURE: "fixture-only",
  MINATO_DATA_PLANE: process.env.MINATO_DATA_PLANE ?? "litellm",
  MINATO_RUNTIME_BASE_URL: process.env.MINATO_RUNTIME_BASE_URL ?? "http://127.0.0.1:14300",
  MINATO_RUNTIME_TOKEN: process.env.MINATO_RUNTIME_TOKEN ?? "runtime-smoke-token" };
const db = connectDatabase();
const admin = createControl(connectDatabase(), config);
const ingress = createIngress(connectDatabase(), config);
const proxy = config.MINATO_DATA_PLANE === "runtime" ? createRuntime(config) : createLiteLlm(config);
const project = "smoke-" + crypto.randomUUID().slice(0, 8);
const fixture = "http://127.0.0.1:18765";

try {
  assert.equal((await admin.inject("/health/ready")).statusCode, 200);
  assert.equal((await ingress.inject("/health/ready")).statusCode, 200);
  const session = await admin.inject({ method: "POST", url: "/admin/v1/session", payload: { password: config.MINATO_ADMIN_PASSWORD } });
  assert.equal(session.statusCode, 204, session.body);
  const cookie = String(session.headers["set-cookie"]).split(";")[0];
  const { csrfToken } = (await admin.inject({ url: "/admin/v1/session", headers: { cookie } })).json();
  const headers = { cookie, "x-csrf-token": csrfToken };
  async function control(method: "POST" | "PUT" | "PATCH" | "DELETE" | "GET", url: string, payload?: object, code = 200) {
    const res = await admin.inject({ method, url: "/admin/v1" + url, headers, payload });
    assert.equal(res.statusCode, code, res.body);
    return res.body ? res.json() : null;
  }
  await control("POST", "/projects", { slug: project, displayName: "Smoke" }, 201);
  const prefix = "/projects/" + project + "/environments";
  const prod = await control("POST", prefix, { slug: "production", displayName: "Production" }, 201);
  await control("POST", prefix, { slug: "other", displayName: "Other" }, 201);
  const key = await control("POST", prefix + "/production/keys", { label: "Smoke key" }, 201);
  const expired = await control("POST", prefix + "/production/keys", { label: "Expired smoke key" }, 201);
  await db`update environment_keys set expires_at = now() - interval '1 second' where id = ${expired.id}`;
  const other = await control("POST", prefix + "/other/keys", { label: "Other key" }, 201);
  const authorization = { authorization: `Bearer ${key.key}` };
  const url = "/minato/v1" + prefix + "/production/features/summary";
  assert.equal((await admin.inject({ url, headers: { authorization: `Bearer ${expired.key}` } })).statusCode, 401);
  assert(!(JSON.stringify(await control("GET", prefix + "/production/keys")).includes(key.key)));
  assert(!(JSON.stringify(await db`select * from admin_events where entity_id = ${key.id}`).includes(key.key)));
  const declaration = { displayName: "Summary", requirements: { endpoint: "responses" } };
  const registered = await admin.inject({ method: "PUT", url, payload: declaration, headers: authorization });
  assert.equal(registered.statusCode, 201, registered.body);
  const alias = registered.json().alias;
  const again = await admin.inject({ method: "PUT", url, payload: declaration, headers: authorization });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().registrationRevision, 1);
  assert.equal((await admin.inject({ url, headers: { authorization: `Bearer ${other.key}` } })).statusCode, 403);
  assert.equal((await ingress.inject({ method: "POST", url: "/v1/responses", headers: authorization,
    payload: { model: alias, input: "Before publication" } })).statusCode, 503);
  const [feature] = await control("GET", `/environments/${prod.id}/features`);
  await control("PUT", `/environments/${prod.id}/audit-policy`, {
    expectedRevision: 0, enabled: true, retentionDays: 7, contentLimit: 262144, redactKeys: [],
  });
  const routing = `/features/${feature.id}/routing`;
  const fixtureBase = process.env.MINATO_SMOKE_API_BASE ?? "http://fixture:18765";
  const candidates = [
    { sourceId: "fixture", modelId: "Model A", apiBase: fixtureBase + "/primary/v1", credentialEnv: "MINATO_UPSTREAM_FIXTURE", upstreamEndpoint: "responses" },
    { sourceId: "opencode-fixture", modelId: "model-b", apiBase: fixtureBase + "/backup/v1", credentialEnv: "MINATO_UPSTREAM_FIXTURE", upstreamEndpoint: "chat-completions" },
  ];
  await control("PUT", routing, { expectedRevision: 0, candidates });
  const queued = await control("POST", routing + "/publish", { expectedRevision: 1 }, 202);
  while (await publishNextRoute(db, proxy)) { /* drain local test queue */ }
  assert.equal((await control("GET", routing + "/versions"))[0].state, "active");
  assert.equal((await ingress.inject({ method: "POST", url: "/v1/responses", headers: { authorization: `Bearer ${other.key}` },
    payload: { model: alias, input: "Wrong environment" } })).statusCode, 404);
  const internalModel = config.MINATO_DATA_PLANE === "runtime" ? `minato-${feature.id}-1` : `minato-${feature.id}-1-0`;
  assert.equal((await ingress.inject({ method: "POST", url: "/v1/responses", headers: authorization,
    payload: { model: internalModel, input: "Internal group" } })).statusCode, 404);
  const predict = (stream = false) => ingress.inject({ method: "POST", url: "/v1/responses",
    headers: { ...authorization, "x-opencode-session": "smoke-session" },
    payload: { model: alias, input: "Synthetic test input", stream } });
  const fixtureMode = async (primary: string) => {
    const res = await fetch(fixture + "/fixture/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ primary }) });
    assert.equal(res.status, 200);
  };
  const calls = async () => await (await fetch(fixture + "/fixture/calls")).json();
  await fixtureMode("ok");
  const normal = await predict();
  assert.equal(normal.statusCode, 200, normal.body);
  assert.equal(normal.json().model, alias);
  const sdk = new OpenAI({ apiKey: key.key, baseURL: "http://minato.test/v1", maxRetries: 0,
    fetch: async (url, options) => {
      const request = new Request(url, options);
      const response = await ingress.inject({
        url: new URL(request.url).pathname,
        method: request.method as "POST" | "GET",
        headers: Object.fromEntries(request.headers),
        payload: request.body ? await request.text() : undefined,
      });
      return new Response(response.body, { status: response.statusCode,
        headers: { "content-type": String(response.headers["content-type"] ?? "application/json") } });
    },
  });
  assert.equal((await sdk.responses.create({ model: alias, input: "SDK test" })).model, alias);
  const chatPath = "/minato/v1" + prefix + "/production/features/chat";
  const chat = await admin.inject({ method: "PUT", url: chatPath, headers: authorization,
    payload: { displayName: "Chat", requirements: { endpoint: "chat-completions" } } });
  assert.equal(chat.statusCode, 201, chat.body);
  const chatFeature = (await control("GET", `/environments/${prod.id}/features`)).find((entry: { slug: string }) => entry.slug === "chat");
  const chatRoute = `/features/${chatFeature.id}/routing`;
  await control("PUT", chatRoute, { expectedRevision: 0, candidates: [candidates[1]] });
  await control("POST", chatRoute + "/publish", { expectedRevision: 1 }, 202);
  while (await publishNextRoute(db, proxy)) { /* drain local test queue */ }
  assert.equal((await sdk.chat.completions.create({
    model: chat.json().alias, messages: [{ role: "user", content: "SDK chat test" }],
  })).model, chat.json().alias);
  await fixtureMode("rate_limit");
  const fallback = await predict();
  assert.equal(fallback.statusCode, 200, fallback.body);
  assert.equal(fallback.json().usage.total_tokens, 12);
  assert.equal((await calls()).length, 2);
  assert.equal((await calls())[1].session, "smoke-session");
  await fixtureMode("rate_limit");
  const streamed = await predict(true);
  assert.equal(streamed.statusCode, 200);
  assert.match(streamed.body, /response\.completed/);
  await fixtureMode("stream_partial");
  const partial = await predict(true);
  assert.equal(partial.statusCode, 200);
  assert.match(partial.body, /partial synthetic output/);
  assert.equal((await calls()).length, 1);
  const partialPath = "/calls/" + String(partial.headers["x-request-id"]);
  for (let i = 0; i < 25; i++) {
    const observed = await control("GET", partialPath).catch(() => undefined);
    if (observed?.status === "interrupted") break;
    if (i === 24) assert.fail("Partial stream was not audited as interrupted");
    await Bun.sleep(40);
  }
  await fixtureMode("invalid_request");
  assert.equal((await predict()).statusCode, 400);
  assert.equal((await calls()).length, 1);
  const requestId = String(fallback.headers["x-request-id"]);
  const callPath = "/calls/" + requestId;
  let audited: { content: { kind: string; value: unknown }[] } | undefined;
  for (let i = 0; i < 30; i++) {
    const current = await control("GET", callPath + "/content").catch(() => undefined);
    if (current?.content.length === 2) { audited = current; break; }
    await Bun.sleep(50);
  }
  assert(audited?.content.find((entry) => entry.kind === "request"));
  const details = await control("GET", callPath);
  assert.equal(details.attempts.length, 2);
  assert.equal(details.attempts[1].total_tokens, "12");
  const totals = await control("GET", `/environments/${prod.id}/usage`);
  assert(totals.requestCount >= 5 && totals.unknownAttempts >= 2);
  const page = await control("GET", `/environments/${prod.id}/calls?limit=2`);
  assert(page.before);
  const nextPage = await control("GET", `/environments/${prod.id}/calls?limit=2&before=${encodeURIComponent(page.before)}`);
  assert.equal(new Set([...page.items, ...nextPage.items].map((entry: { requestId: string }) => entry.requestId)).size, 4);
  const usageEvent = { attemptId: crypto.randomUUID(), usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12,
    input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } } };
  for (let i = 0; i < 2; i++) {
    assert.equal((await admin.inject({ method: "POST", url: "/internal/v1/litellm/usage",
      headers: { authorization: `Bearer ${config.MINATO_CALLBACK_SECRET}` }, payload: usageEvent })).statusCode, 204);
  }
  const [received] = await db`select count(*)::int as count, sum(total_tokens)::int as total
    from attempt_usage where attempt_id = ${usageEvent.attemptId}`;
  assert.deepEqual({ ...received }, { count: 1, total: 12 });
  const { id: memberId } = await control("POST", "/members", { username: project, password: "synthetic-member-password" }, 201);
  await control("PUT", `/environments/${prod.id}/members/${memberId}`, { usage: true, content: false, test: true });
  const memberLogin = await admin.inject({ method: "POST", url: "/admin/v1/session", payload: { username: project, password: "synthetic-member-password" } });
  assert.equal(memberLogin.statusCode, 204);
  const memberHeaders = { cookie: String(memberLogin.headers["set-cookie"]).split(";")[0] };
  assert.equal((await admin.inject({ url: "/admin/v1" + callPath, headers: memberHeaders })).statusCode, 200);
  assert.equal((await admin.inject({ url: "/admin/v1" + callPath + "/content", headers: memberHeaders })).statusCode, 403);
  await control("PUT", `/environments/${prod.id}/members/${memberId}`, { usage: true, content: true, test: true });
  assert.equal((await admin.inject({ url: "/admin/v1" + callPath + "/content", headers: memberHeaders })).statusCode, 200);
  const replayHeaders = { ...headers, "idempotency-key": crypto.randomUUID() };
  await fixtureMode("ok");
  const replayBody = { featureId: feature.id, replayOf: requestId,
    endpoint: "responses", request: { input: "Replay sample" }, target: { mode: "active_route" } };
  const submitReplay = async () => {
    const res = await admin.inject({ method: "POST", url: `/admin/v1/environments/${prod.id}/tests`, headers: replayHeaders, payload: replayBody });
    assert.equal(res.statusCode, 202, res.body);
    return res.json().id;
  };
  const replayId = await submitReplay();
  assert.equal(await submitReplay(), replayId);
  const missingContext = await admin.inject({ method: "POST", url: `/admin/v1/environments/${prod.id}/tests`,
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    payload: { ...replayBody, request: { input: "Follow up", previous_response_id: "resp_remote" } } });
  assert.equal(missingContext.statusCode, 422);
  assert.equal(missingContext.json().code, "missing_replay_context");
  assert(await createTestRunner(db, proxy, config)());
  const replayResult = await control("GET", "/tests/" + replayId);
  assert.equal(replayResult.status, "succeeded", JSON.stringify(replayResult));
  assert.equal(replayResult.replayOf, requestId);
  assert.equal(replayResult.output.actualModel, "Model A");
  const source = await control("POST", "/sources", { slug: project, kind: "openai",
    directoryUrl: "http://127.0.0.1:18765/fixture/calls", apiBase: "http://fixture:18765/backup/v1",
    credentialEnv: "MINATO_UPSTREAM_FIXTURE", defaultEndpoint: "chat-completions", enabled: true }, 201);
  await control("PUT", `/sources/${source.id}/models/model-b`, {});
  const chosen = await admin.inject({ method: "POST", url: `/admin/v1/environments/${prod.id}/tests`,
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    payload: { ...replayBody, replayOf: undefined, target: { mode: "specific_model", sourceId: project, modelId: "model-b" } } });
  assert.equal(chosen.statusCode, 202, chosen.body);
  assert(await createTestRunner(db, proxy, config)());
  const chosenResult = await control("GET", "/tests/" + chosen.json().id);
  assert.equal(chosenResult.status, "succeeded", JSON.stringify(chosenResult));
  assert.equal(chosenResult.output.actualModel, "model-b");
  assert.equal(chosenResult.output.response.usage.total_tokens, 12);
  await control("PATCH", `/sources/${source.id}`, {
    kind: "openai", directoryUrl: "http://127.0.0.1:18765/fixture/calls", apiBase: "http://fixture:18765/backup/v1",
    credentialEnv: "MINATO_UPSTREAM_FIXTURE", defaultEndpoint: "chat-completions", enabled: false, expectedRevision: 1 });
  await db`update call_content set expires_at = now() - interval '1 second' where request_id = ${requestId}`;
  await cleanExpired(db);
  const expiredCall = await control("GET", callPath + "/content");
  assert.equal(expiredCall.state, "expired");
  assert.deepEqual(expiredCall.content, []);
  assert.equal((await control("GET", callPath)).attempts.length, 2);
  const protectedCall = async (body: string) => ingress.inject({ method: "POST", url: "/v1/responses",
    headers: authorization, payload: { model: alias, input: body } });
  await control("PUT", `/environments/${prod.id}/audit-policy`, {
    expectedRevision: 1, enabled: false, retentionDays: 7, contentLimit: 4096, redactKeys: [],
  });
  const disabled = await protectedCall("AUDIT_DISABLED_SYNTHETIC_MARKER");
  const disabledId = String(disabled.headers["x-request-id"]);
  async function awaitAudit(id: string, check: (record: any) => boolean) {
    for (let i = 0; i < 30; i++) {
      const output = await control("GET", "/calls/" + id + "/content").catch(() => undefined);
      if (output && check(output)) return output;
      await Bun.sleep(30);
    }
    assert.fail("Audit did not reach the expected state");
  }
  const off = await awaitAudit(disabledId, (record) => record.state === "disabled");
  assert.deepEqual(off.content, []);
  await control("PUT", `/environments/${prod.id}/audit-policy`, {
    expectedRevision: 2, enabled: true, retentionDays: 7, contentLimit: 4096, redactKeys: ["customer_id"],
  });
  const long = await protectedCall("long synthetic prompt ".repeat(350));
  await awaitAudit(String(long.headers["x-request-id"]), (record) =>
    record.content.some((part: { kind: string; state: string }) => part.kind === "request" && part.state === "truncated"));
  const failureHook = "smoke_audit_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await db.unsafe(`create function ${failureHook}() returns trigger language plpgsql as $$
      begin if new.environment_id = '${prod.id}'::uuid then raise exception 'synthetic audit failure'; end if;
      return new; end $$`);
    await db.unsafe(`create trigger ${failureHook} before insert on calls
      for each row execute function ${failureHook}()`);
    const before = (await ingress.inject("/health/ready")).json().audit.lost;
    const underFault = await protectedCall("Synthetic audit database fault");
    assert.equal(underFault.statusCode, 200);
    for (let i = 0; i < 30; i++) {
      if ((await ingress.inject("/health/ready")).json().audit.lost > before) break;
      if (i === 29) assert.fail("Audit writer failure was not exposed through readiness metrics");
      await Bun.sleep(20);
    }
  } finally {
    await db.unsafe(`drop trigger if exists ${failureHook} on calls`);
    await db.unsafe(`drop function if exists ${failureHook}()`);
  }
  await fixtureMode("rate_limit");
  const waiting = ingress.inject({ method: "POST", url: "/v1/responses", headers: authorization,
    payload: { model: alias, input: "delayed fixture" } }).then((result) => result);
  for (let i = 0; !(await calls()).length; i++) {
    assert(i < 50, "In-flight primary did not reach the fixture");
    await Bun.sleep(20);
  }
  await control("PUT", routing, { expectedRevision: 1, candidates: [candidates[0], { ...candidates[1], modelId: "model-c" }] });
  const replacement = await control("POST", routing + "/publish", { expectedRevision: 2 }, 202);
  while (await publishNextRoute(db, proxy)) { /* drain local test queue */ }
  assert.equal((await predict()).statusCode, 200);
  assert.equal((await waiting).statusCode, 200);
  const backupModels = (await calls()).filter(({ path }: { path: string }) => path.includes("/backup")).map(({ model }: { model: string }) => model);
  assert.deepEqual(backupModels.sort(), ["model-b", "model-c"]);
  await control("POST", routing + "/rollback", { version: queued.version, expectedActiveVersion: replacement.version }, 202);
  while (await publishNextRoute(db, proxy)) { /* drain local test queue */ }
  assert.equal((await control("GET", routing + "/versions"))[0].state, "active");
  await fixtureMode("rate_limit");
  assert.equal((await predict()).statusCode, 200);
  assert.equal((await calls()).at(-1).model, "model-b");
  await control("PUT", routing, { expectedRevision: 2, candidates: candidates.map((entry) => ({
    ...entry, credentialEnv: "MINATO_UPSTREAM_UNCONFIGURED_SMOKE",
  })) });
  await control("POST", routing + "/publish", { expectedRevision: 3 }, 202);
  await control("PUT", routing, { expectedRevision: 3, candidates });
  await control("POST", routing + "/publish", { expectedRevision: 4 }, 202);
  while (await publishNextRoute(db, proxy)) { /* drain local test queue */ }
  const versions = await control("GET", routing + "/versions");
  assert.equal(versions[0].state, "active");
  assert.equal(versions[1].state, "failed");
  await fixtureMode("ok");
  assert.equal((await predict()).statusCode, 200);
  await control("DELETE", prefix + "/production/keys/" + key.id, undefined, 204);
  assert.equal((await predict()).statusCode, 401);
  assert.equal((await admin.inject({ url, headers: authorization })).statusCode, 401);
  const [stuck] = await db`insert into tests (environment_id, feature_id, idempotency_key, fingerprint, endpoint, target, status, started_at)
    values (${prod.id}, ${feature.id}, ${crypto.randomUUID()}, 'fixture', 'responses', '{"mode":"active_route"}',
      'running', now() - interval '5 minutes') returning id`;
  await cleanExpired(db);
  assert.equal((await control("GET", "/tests/" + stuck.id)).status, "unknown");
  console.log("Verified registration, publication, OpenAI SDK, fallback, SSE, rollback, revocation, audit, usage and replay.");
} finally {
  await Promise.all([db.close(), admin.close(), ingress.close()]);
}
