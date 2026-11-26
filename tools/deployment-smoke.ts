import assert from "node:assert/strict";
import OpenAI from "openai";

const base = process.env.MINATO_SMOKE_ORIGIN ?? "http://127.0.0.1:18088";
const fixture = process.env.MINATO_SMOKE_FIXTURE ?? "http://host.docker.internal:18765";
const compatibilityBase = process.env.MINATO_SMOKE_LITELLM_BASE;
const dashboardOrigin = process.env.MINATO_SMOKE_LITELLM_UI_ORIGIN;
const password = process.env.MINATO_SMOKE_PASSWORD;
if (!password) throw new Error("Set MINATO_SMOKE_PASSWORD");
let headers: Record<string, string> = { "content-type": "application/json" };

async function request(path: string, method = "GET", body?: unknown, status = 200) {
  const response = await fetch(new URL(path, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, status, `${method} ${path}`);
  return response;
}
async function admin(path: string, method = "GET", body?: unknown, status = 200) {
  return (await request("/admin/v1" + path, method, body, status)).json();
}

if (dashboardOrigin) {
  const uiPassword = process.env.MINATO_SMOKE_LITELLM_UI_PASSWORD;
  assert(uiPassword, "Set MINATO_SMOKE_LITELLM_UI_PASSWORD");
  const page = await fetch(new URL("/ui/login", dashboardOrigin));
  assert.equal(page.status, 200);
  const script = (await page.text()).match(/src="(\/litellm-asset-prefix\/[^"]+\.js)"/)?.[1];
  assert(script);
  const asset = await fetch(new URL(script, dashboardOrigin));
  assert(asset.ok && asset.headers.get("content-type")?.includes("javascript"));
  await asset.body?.cancel();
  for (let i = 0; i < 90; i++) {
    const discovery = await fetch(new URL("/litellm/.well-known/litellm-ui-config", dashboardOrigin));
    await discovery.body?.cancel();
    if (discovery.ok) break;
    assert(i < 89, `LiteLLM Dashboard discovery returned ${discovery.status}`);
    await Bun.sleep(1000);
  }
  const login = await fetch(new URL("/v2/login", dashboardOrigin), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: process.env.MINATO_SMOKE_LITELLM_UI_USERNAME ?? "admin", password: uiPassword }),
  });
  assert.equal(login.status, 200);
  const { token, redirect_url } = await login.json();
  assert(token);
  assert.equal(new URL(redirect_url).origin, new URL(dashboardOrigin).origin);
  console.log("Verified LiteLLM Dashboard assets, discovery and login through the static frontend.");
}

const index = await (await request("/")).text();
const asset = index.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
assert(asset && (await request(asset)).headers.get("content-type")?.includes("javascript"));
for (let i = 0; i < 90; i++) {
  const readiness = await fetch(base + "/health/ready");
  if (readiness.ok) break;
  if (i === 89) throw new Error("Deployment never became ready");
  await Bun.sleep(1000);
}
const login = await request("/admin/v1/session", "POST", { password }, 204);
headers.cookie = login.headers.get("set-cookie")!.split(";")[0];
headers["x-csrf-token"] = (await admin("/session")).csrfToken;
const slug = "release-" + crypto.randomUUID().slice(0, 8);
await admin("/projects", "POST", { slug, displayName: process.env.MINATO_SMOKE_PROJECT_NAME ?? "Release sample" }, 201);
const path = `/projects/${slug}/environments`;
const environment = await admin(path, "POST", { slug: "production", displayName: "Production" }, 201);
await admin(`/environments/${environment.id}/audit-policy`, "PUT", {
  expectedRevision: 0, enabled: true, retentionDays: 9, contentLimit: 262144, redactKeys: [],
});
const { key } = await admin(path + "/production/keys", "POST", { label: "Release fixture" }, 201);
const registration = await fetch(base + "/minato/v1" + path + "/production/features/classify", {
  method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ displayName: "Classification", requirements: { endpoint: "responses" } }),
});
assert.equal(registration.status, 201);
const { alias } = await registration.json();
const [feature] = await admin(`/environments/${environment.id}/features`);
const route = `/features/${feature.id}/routing`;
await admin(route, "PUT", { expectedRevision: 0, candidates: [{ sourceId: "fixture", modelId: "Model A",
  apiBase: fixture + "/primary/v1", credentialEnv: "MINATO_UPSTREAM_RELEASE_FIXTURE", upstreamEndpoint: "responses" }] });
await admin(route + "/publish", "POST", { expectedRevision: 1 }, 202);
for (let i = 0; i < 60; i++) {
  const [version] = await admin(route + "/versions");
  if (version.state === "active") break;
  if (version.state === "failed" || i === 59) throw new Error(`Publication ended with ${version.state}: ${version.errorCode}`);
  await Bun.sleep(500);
}
const client = new OpenAI({ baseURL: base + "/v1", apiKey: key, maxRetries: 0 });
const correlationId = "release-" + crypto.randomUUID();
const { data: result, response: inference } = await client.responses
  .create({ model: alias, input: "Synthetic deployment sample." }, { headers: { "x-minato-correlation-id": correlationId } })
  .withResponse();
assert.equal(result.model, alias);
assert.equal(result.usage?.total_tokens, 10);
const requestId = inference.headers.get("x-request-id");
assert(requestId);
for (let i = 0; i < 40; i++) {
  const { items } = await admin(`/environments/${environment.id}/calls?correlationId=${correlationId}`);
  const call = items.find((entry: { requestId: string }) => entry.requestId === requestId);
  if (call?.captureState === "captured") {
    assert.equal(call.totalTokens, "10");
    const { content } = await admin("/calls/" + requestId + "/content");
    assert.deepEqual(content.map((part: { kind: string }) => part.kind).sort(), ["request", "response"]);
    break;
  }
  assert(i < 39, "Captured request not found by correlation ID");
  await Bun.sleep(250);
}
const report = await admin(`/environments/${environment.id}/usage?kind=production`);
assert.equal(report.knownTotalTokens, "10");
const blocked = await fetch(base + "/internal/v1/litellm/usage", { method: "POST" });
assert.equal(blocked.status, 404);

headers["idempotency-key"] = crypto.randomUUID();
const test = await admin(`/environments/${environment.id}/tests`, "POST", {
  featureId: feature.id, endpoint: "responses",
  request: { input: "delayed fixture" }, target: { mode: "active_route" },
}, 202);
delete headers["idempotency-key"];
for (let i = 0; i < 30; i++) {
  const current = await admin(`/tests/${test.id}`);
  if (current.status === "running") break;
  assert.equal(current.status, "queued");
  assert(i < 29, "Replay never started");
  await Bun.sleep(100);
}
const replacement = await admin(route + "/publish", "POST", { expectedRevision: 1 }, 202);
for (let i = 0; i < 30; i++) {
  const [current] = await admin(route + "/versions");
  const replay = await admin(`/tests/${test.id}`);
  assert.equal(replay.status, "running", "A running replay delayed route publication");
  if (current.state === "active" && current.version === replacement.version) break;
  assert(i < 29, "Replacement route never became active");
  await Bun.sleep(100);
}
for (let i = 0; i < 60; i++) {
  const current = await admin(`/tests/${test.id}`);
  if (current.status === "succeeded") break;
  assert.equal(current.status, "running");
  assert(i < 59, "Replay did not finish");
  await Bun.sleep(100);
}
console.log("Verified console assets, readiness, authentication, SDK inference and route publication during replay through Compose.");

const switched = await admin(route, "PUT", { expectedRevision: 1, candidates: [{ sourceId: "fixture-backup",
  modelId: "model-b", apiBase: fixture + "/backup/v1", credentialEnv: "MINATO_UPSTREAM_RELEASE_FIXTURE",
  upstreamEndpoint: "chat-completions" }] });
const manual = await admin(route + "/publish", "POST", { expectedRevision: switched.draftRevision }, 202);
async function waitForActive(version: string) {
  for (let i = 0; i < 60; i++) {
    const [current] = await admin(route + "/versions");
    if (current.version === version && current.state === "active") return;
    assert(current.state !== "failed" && i < 59, JSON.stringify(current));
    await Bun.sleep(500);
  }
}
await waitForActive(manual.version);
const changed = await client.responses.create({ model: alias, input: "Synthetic switch sample." });
assert.equal(changed.model, alias);
assert.equal(changed.usage?.total_tokens, 12);
const rolledBack = await admin(route + "/rollback", "POST", {
  version: replacement.version, expectedActiveVersion: manual.version,
}, 202);
await waitForActive(rolledBack.version);
const restored = await client.responses.create({ model: alias, input: "Synthetic rollback sample." });
assert.equal(restored.model, alias);
assert.equal(restored.usage?.total_tokens, 10);
console.log("Verified manual model switch and rollback under the original business alias.");

if (compatibilityBase) {
  const fixtureControl = process.env.MINATO_SMOKE_FIXTURE_CONTROL ?? "http://127.0.0.1:18765";
  const setPrimary = async (primary: string) => {
    const response = await fetch(fixtureControl + "/fixture/mode", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ primary }),
    });
    assert.equal(response.status, 200);
  };
  const primary = { kind: "openai", directoryUrl: fixture + "/primary/v1/models", apiBase: fixture + "/primary/v1",
    credentialEnv: "MINATO_UPSTREAM_RELEASE_FIXTURE", defaultEndpoint: "responses" };
  const primarySource = await admin("/sources", "POST", { slug: slug + "-go", ...primary }, 201);
  const compatibilitySource = await admin("/sources", "POST", {
    slug: slug + "-python", kind: "openai", apiBase: compatibilityBase, directoryUrl: compatibilityBase + "/models",
    credentialEnv: "MINATO_UPSTREAM_LITELLM", defaultEndpoint: "chat-completions",
  }, 201);
  for (const [source, modelId] of [[primarySource, "Model A"], [compatibilitySource, "compat-fixture"]]) {
    for (let i = 0; i < 60; i++) {
      const models = await admin(`/sources/${source.id}/models`);
      if (models.some((model: { modelId: string; status: string }) => model.modelId === modelId && model.status === "listed")) break;
      assert(i < 59, `Model ${modelId} missing from source ${source.slug}`);
      await Bun.sleep(500);
    }
  }
  await admin(`/sources/${compatibilitySource.id}/models/compat-fixture`, "PUT", {
    inputPricePerMillion: 1, outputPricePerMillion: 2, priceCurrency: "USD",
  });
  await admin(`/environments/${environment.id}/defaults`, "PUT", {
    pool: [{ sourceId: compatibilitySource.slug, modelId: "compat-fixture" }],
  });
  const updated = await admin(route, "PUT", { expectedRevision: switched.draftRevision, policy: {
    primary: { sourceId: primarySource.slug, modelId: "Model A" },
  } });
  const pending = await admin(route + "/publish", "POST", { expectedRevision: updated.draftRevision }, 202);
  for (let i = 0; i < 60; i++) {
    const [version] = await admin(route + "/versions");
    if (version.version === pending.version && version.state === "active") break;
    assert(version.state !== "failed" && i < 59, JSON.stringify(version));
    await Bun.sleep(500);
  }
  try {
    await setPrimary("rate_limit");
    for (const stream of [false, true]) {
      const response = await fetch(base + "/v1/responses", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: alias, input: "Synthetic compatibility sample.", stream }),
      });
      const output = await response.text();
      assert.equal(response.status, 200, output);
      if (stream) assert.match(output, /response\.completed/);
      assert.match(output, /incident/);
      const requestId = response.headers.get("x-request-id");
      assert(requestId);
      for (let i = 0; i < 30; i++) {
        const call = await admin("/calls/" + requestId).catch(() => undefined);
        if (call?.attempts.length === 2 && call.attempts[1].total_tokens !== null) {
          assert.equal(call.attempts[0].http_status, 429);
          assert.equal(call.attempts[1].source_id, compatibilitySource.slug);
          assert.equal(call.attempts[1].total_tokens, "12");
          break;
        }
        assert(i < 29, "Compatibility attempt or token usage missing");
        await Bun.sleep(100);
      }
      for (let i = 0; i < 30; i++) {
        const audit = await admin("/calls/" + requestId + "/content").catch(() => undefined);
        if (audit?.content.some((entry: { kind: string }) => entry.kind === "response")) break;
        assert(i < 29, "Compatibility response missing from audit");
        await Bun.sleep(100);
      }
    }
    const calls = await (await fetch(fixtureControl + "/fixture/calls")).json();
    assert.deepEqual(calls.map((call: { model: string }) => call.model), ["Model A", "model-b", "Model A", "model-b"]);
    const usage = await admin(`/environments/${environment.id}/usage`);
    assert.equal(usage.costKnownAttempts, 2);
    assert.equal(Number(usage.estimatedCostUsd), 0.000032);
      assert.equal(usage.costTrend.reduce((total: number, day: { costKnownAttempts: number }) => total + day.costKnownAttempts, 0), 2);
      assert.equal(usage.costTrend.reduce((total: number, day: { estimatedCostUsd: string | null }) =>
        total + Number(day.estimatedCostUsd), 0), 0.000032);
  } finally {
    await setPrimary("ok");
  }

  await admin(`/sources/${primarySource.id}`, "PATCH", { ...primary, enabled: false, expectedRevision: 1 });
  for (let i = 0; i < 60; i++) {
    const [current] = await admin(route + "/versions");
    if (current.version !== pending.version && current.state === "active") break;
    assert(current.state !== "failed" && i < 59, JSON.stringify(current));
    await Bun.sleep(500);
  }
  const result = await client.responses.create({ model: alias, input: "Synthetic sample after source removal." });
  assert.equal(result.model, alias);
  assert.equal(result.usage?.total_tokens, 12);
  const calls = await (await fetch(fixtureControl + "/fixture/calls")).json();
  assert.deepEqual(calls.map((call: { model: string }) => call.model), ["model-b"]);
  console.log("Verified Go to LiteLLM fallback, SSE, cost and audit, and automatic route republication after source disablement.");
}
