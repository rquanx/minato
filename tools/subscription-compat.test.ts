import { afterEach, expect, test } from "bun:test";
import { attachGoogleProject, beginKimiLogin } from "../packages/litellm/subscription-auth";
import { subscriptionRequest } from "../packages/litellm/subscription-inference";

const fetchUpstream = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchUpstream; });

for (const kind of ["gemini-cli", "antigravity"] as const) {
  test(kind + " onboards an account without a Code Assist project", async () => {
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = (async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
      return calls.length === 1 ? Response.json({ allowedTiers: [{ id: "default", isDefault: true }] })
        : Response.json({ done: true, response: { cloudaicompanionProject: { id: " assigned-project " } } });
    }) as typeof fetch;
    const tokens = { accessToken: "test-token", expiresAt: Date.now() + 60_000 };
    expect((await attachGoogleProject(kind, "test", {}, tokens)).projectId).toBe("assigned-project");
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual(["/v1internal:loadCodeAssist", "/v1internal:onboardUser"]);
    expect(calls[1].body).toEqual({ tierId: "default", metadata: {
      ideType: kind === "antigravity" ? "ANTIGRAVITY" : "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI",
    } });
  });
}

test("Kimi accepts a prefilled verification URL by itself", async () => {
  globalThis.fetch = (async () => Response.json({
    device_code: "test-device", user_code: "EXAMPLE", verification_uri_complete: "https://auth.kimi.com/device?code=EXAMPLE",
    expires_in: 300,
  })) as unknown as typeof fetch;
  expect((await beginKimiLogin()).verificationUrl).toBe("https://auth.kimi.com/device?code=EXAMPLE");
});

test("Claude uses the OAuth Messages endpoint and beta header", async () => {
  globalThis.fetch = (async (url, options) => {
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(new Headers(options?.headers).get("anthropic-beta")).toContain("oauth-2025-04-20");
    return Response.json({});
  }) as typeof fetch;
  await subscriptionRequest("claude", "test-model", {}, { accessToken: "test-token" }, false, AbortSignal.timeout(1000));
});

test("Antigravity uses an agent request ID in the Code Assist envelope", async () => {
  globalThis.fetch = (async (url, options) => {
    expect(new URL(String(url)).pathname).toBe("/v1internal:generateContent");
    expect(JSON.parse(String(options?.body))).toEqual({
      model: "test-model", project: "test-project", request: { contents: [] },
      userAgent: "antigravity", requestType: "agent", requestId: expect.stringMatching(/^agent-[a-f0-9-]{36}$/),
    });
    return Response.json({});
  }) as typeof fetch;
  await subscriptionRequest("antigravity", "test-model", { contents: [] },
    { accessToken: "test-token", projectId: "test-project" }, false, AbortSignal.timeout(1000));
});
