import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { googleSubscription, providerUrls } from "../../packages/contracts/providers";
import { readSourceCredential } from "../../packages/db/source-credentials";
import { subscriptionRequest, unwrapCloudResponse, unwrapCloudStream } from "../../packages/litellm/subscription-inference";
import type { Database } from "../control/auth";

const digest = (key: string) => createHash("sha256").update(key).digest();
const inputs = z.record(z.string(), z.unknown());

export function registerSubscriptionRelay(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv) {
  const credential = readSourceCredential(db, env);
  const secret = env.MINATO_RUNTIME_PUBLISH_TOKEN || env.MINATO_RUNTIME_TOKEN;
  for (const kind of ["claude", "gemini-cli", "antigravity", "kimi"] as const) {
    const google = googleSubscription(kind);
    const path = google ? "/v1beta/models/:action" : kind === "claude" ? "/messages" : "/chat/completions";
    app.post("/internal/providers/" + kind + path, async (request, reply) => {
      const proof = request.headers["x-minato-provider-token"];
      if (!secret || typeof proof !== "string" || !timingSafeEqual(digest(secret), digest(proof))) return reply.code(404).send();
      const identity = z.object({ source: z.string().min(1), credential: z.uuid() }).safeParse({
        source: request.headers["x-minato-source"], credential: request.headers["x-minato-credential-id"],
      });
      const input = inputs.safeParse(request.body);
      if (!identity.success || !input.success) return reply.code(400).send({ error: { code: "invalid_request" } });
      const action = (request.params as { action?: string }).action?.match(/^([^:/]+):(generateContent|streamGenerateContent)$/);
      const model = google ? action?.[1] : input.data.model;
      if (typeof model !== "string" || !model) return reply.code(400).send({ error: { code: "invalid_model" } });
      const stream = google ? action?.[2] === "streamGenerateContent" : input.data.stream === true;
      const stop = new AbortController();
      reply.raw.once("close", () => { if (!reply.raw.writableEnded) stop.abort(); });
      const bundle = await credential(identity.data.source, identity.data.credential, providerUrls[kind]!.base, kind).catch(() => undefined);
      if (!bundle) return reply.code(401).send({ error: { code: "upstream_credential_unavailable" } });
      const response = await subscriptionRequest(kind, model, input.data, bundle, stream,
        AbortSignal.any([stop.signal, AbortSignal.timeout(120_000)])).catch(() => undefined);
      if (!response) return reply.code(502).send({ error: { code: "upstream_unreachable" } });
      if (!response.ok) {
        const raw = (await response.json().catch(() => null))?.error?.code;
        return reply.code(response.status).send({ error: { code: typeof raw === "string" && /^[a-z_]{1,48}$/.test(raw)
          ? raw : response.status === 404 ? "model_not_found" : "upstream_error" } });
      }
      if (stream && response.body) {
        return reply.type("text/event-stream").send(Readable.fromWeb(google ? unwrapCloudStream(response.body) : response.body));
      }
      const data = await response.json().catch(() => null);
      if (!data) return reply.code(502).send({ error: { code: "invalid_upstream_response" } });
      return reply.send(google ? unwrapCloudResponse(data) : data);
    });
  }
}
