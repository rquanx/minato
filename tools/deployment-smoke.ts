import assert from "node:assert/strict";
import OpenAI from "openai";

const base = process.env.MINATO_SMOKE_ORIGIN ?? "http://127.0.0.1:18088";
const fixture = process.env.MINATO_SMOKE_FIXTURE ?? "http://host.docker.internal:18765";
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
await admin("/projects", "POST", { slug, displayName: "Release sample" }, 201);
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
const result = await client.responses.create({ model: alias, input: "Synthetic deployment sample." });
assert.equal(result.model, alias);
assert.equal(result.usage?.total_tokens, 10);
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
