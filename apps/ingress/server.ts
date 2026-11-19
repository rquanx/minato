import { Readable } from "node:stream";
import Fastify from "fastify";
import { ApiError } from "../../packages/contracts";
import { connectDatabase } from "../../packages/db/client";
import { liteLlmConfig } from "../../packages/litellm/client";
import { createAuth } from "../control/auth";
import { createInference, routeSnapshot, validateInput, type Endpoint } from "./inference";
import { createAudit, observeSse } from "./audit";
import { auditPolicy } from "../../packages/db/audit";

function publicError(error: unknown) {
  const status = error instanceof ApiError ? error.status : (error as { statusCode?: number })?.statusCode ?? 503;
  const code = error instanceof ApiError ? error.code : status >= 500 ? "gateway_unavailable" : "invalid_request";
  const message = error instanceof ApiError ? error.message : status >= 500 ? "Gateway temporarily unavailable" : "Invalid request";
  return { status, payload: { error: { message, type: code, code, param: null } } };
}

export function createIngress(db = connectDatabase(), env = process.env) {
  if (!env.MINATO_KEY_PEPPER || env.MINATO_KEY_PEPPER.length < 32) {
    throw new Error("Set MINATO_KEY_PEPPER (32+ characters)");
  }
  const app = Fastify({ genReqId: () => crypto.randomUUID(), disableRequestLogging: true, logger: true });
  const auth = createAuth(db, env.MINATO_KEY_PEPPER, "", false);
  const infer = createInference(env);
  const proxy = liteLlmConfig(env);
  const audit = createAudit(db, env);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });
  app.setErrorHandler((error, request, reply) => {
    const { status, payload } = publicError(error);
    if (!(error instanceof ApiError) && status >= 500) request.log.error("Gateway request failed");
    return reply.code(status).send(payload);
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    const [database, upstream] = await Promise.allSettled([
      db`select 1 from schema_migrations limit 1`,
      fetch(new URL("/health/liveliness", proxy.base), { headers: proxy.headers, signal: AbortSignal.timeout(2_000) }),
    ]);
    const checks = { database: database.status === "fulfilled", litellm: upstream.status === "fulfilled" && upstream.value.ok };
    if (upstream.status === "fulfilled") await upstream.value.body?.cancel();
    return reply.code(checks.database && checks.litellm ? 200 : 503).send({ ...checks, audit: audit.stats() });
  });
  app.get("/v1/models", async (request) => {
    const identity = await auth.environment(request);
    const rows = await db`select alias from features where environment_id = ${identity.id} and active_version is not null and not unavailable order by alias`;
    return { object: "list", data: rows.map(({ alias }) => ({ id: alias, object: "model", owned_by: "minato" })) };
  });
  for (const [url, endpoint] of [
    ["/v1/responses", "responses"], ["/v1/chat/completions", "chat-completions"],
  ] as const satisfies ReadonlyArray<readonly [string, Endpoint]>) {
    app.post(url, async (request, reply) => {
      const identity = await auth.environment(request);
      const body = validateInput(request.body, endpoint);
      const [feature] = await db`select f.id, f.alias, f.unavailable, f.active_version::text as version, r.requirements, r.candidates,
        e.audit_enabled, e.audit_days, e.audit_limit, e.audit_redact
        from features f left join route_versions r on (f.id, f.active_version) = (r.feature_id, r.version)
        join environments e on e.id = f.environment_id
        where f.environment_id = ${identity.id} and f.alias = ${body.model}`;
      if (!feature) throw new ApiError(404, "model_not_found", "Unknown feature alias for this environment");
      if (feature.unavailable) throw new ApiError(503, "no_eligible_model", "No eligible model for this feature");
      if (!feature.version) throw new ApiError(503, "route_pending", "Feature route is not active");
      const snapshot = routeSnapshot.parse(feature);
      if (snapshot.requirements.endpoint !== endpoint) {
        throw new ApiError(400, "unsupported_endpoint", "Feature does not support this endpoint");
      }
      const controller = new AbortController();
      const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.once("close", abort);
      const rawSession = request.headers["x-opencode-session"];
      const sessionHeader = typeof rawSession === "string" && /^[\w.-]{1,128}$/.test(rawSession) ? rawSession : undefined;
      const policy = auditPolicy.parse({ enabled: feature.audit_enabled, retentionDays: feature.audit_days,
        contentLimit: feature.audit_limit, redactKeys: feature.audit_redact });
      const observed = audit.start({ id: request.id, environmentId: identity.id, snapshot, endpoint, body, policy });
      let finalAttempt: string | undefined;
      const start = performance.now();
      try {
        const result = await infer({
          snapshot, body, sessionHeader, signal: controller.signal,
          onAttempt: (attempt) => { finalAttempt = attempt.id; observed.record(attempt); },
        });
        if ("stream" in result && result.stream) {
          const stream = observeSse(result.stream, endpoint, policy, observed.streamLimit, (status, detail, usage) => {
            if (finalAttempt && usage) observed.usage(finalAttempt, usage);
            observed.finish(status, result.status, performance.now() - start, detail);
          });
          return reply.code(result.status).type("text/event-stream; charset=utf-8")
            .header("Cache-Control", "no-cache, no-transform")
            .header("X-Accel-Buffering", "no")
            .send(Readable.fromWeb(stream));
        }
        observed.finish("succeeded", result.status, performance.now() - start, result.payload);
        return reply.code(result.status).send(result.payload);
      } catch (error) {
        const { status, payload } = publicError(error);
        observed.finish(controller.signal.aborted ? "cancelled" : "failed", status, performance.now() - start, payload);
        throw error;
      }
    });
  }
  app.addHook("onClose", async () => { await audit.flush(); await db.close(); });
  return app;
}

if (import.meta.main) {
  const app = createIngress();
  process.once("SIGINT", () => void app.close());
  process.once("SIGTERM", () => void app.close());
  await app.listen({ host: process.env.MINATO_HOST ?? "127.0.0.1", port: Number(process.env.MINATO_INGRESS_PORT ?? 4200) });
}
