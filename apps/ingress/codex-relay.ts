import { timingSafeEqual, createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { codexBase, codexHeaders } from "../../packages/litellm/codex-auth";
import { codexRequest, codexResult } from "../../packages/litellm/codex-response";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function registerCodexRelay(app: FastifyInstance, env: NodeJS.ProcessEnv) {
  app.post("/internal/providers/codex/responses", async (request, reply) => {
    const secret = env.MINATO_RUNTIME_PUBLISH_TOKEN || env.MINATO_RUNTIME_TOKEN;
    const supplied = request.headers["x-minato-provider-token"];
    if (!secret || typeof supplied !== "string" || !timingSafeEqual(digest(supplied), digest(secret))) {
      return reply.code(404).send();
    }
    const token = /^Bearer ([!-~]+)$/.exec(request.headers.authorization ?? "")?.[1];
    const input = request.body as Record<string, unknown> | null;
    if (!token || !input || typeof input.model !== "string") {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Invalid Codex request" } });
    }
    const stop = new AbortController();
    reply.raw.once("close", () => { if (!reply.raw.writableEnded) stop.abort(); });
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(120_000)]);
    let response: Response;
    try {
      response = await fetch(codexBase + "/responses", { method: "POST", redirect: "error", signal,
        headers: { ...codexHeaders(token), "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(codexRequest(input)) });
    } catch {
      return reply.code(502).send({ error: { code: "upstream_unreachable", message: "Could not reach Codex" } });
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
      const raw = payload?.error?.code;
      const code = typeof raw === "string" && /^[a-z_]{1,48}$/.test(raw) ? raw : "upstream_error";
      return reply.code(response.status).send({ error: { code, message: "Codex rejected the request" } });
    }
    if (input.stream && response.body) {
      return reply.type("text/event-stream").send(Readable.fromWeb(response.body));
    }
    if (response.body) {
      const result = await codexResult(response.body).catch(() => undefined);
      if (result) return reply.send(result);
    }
    return reply.code(502).send({ error: { code: "upstream_error", message: "Codex closed the stream without a result" } });
  });
}
