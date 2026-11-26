import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { ApiError, endpointPaths, runtimeOnlyEndpoint, uploadEndpoints } from "../../packages/contracts";
import { connectDatabase } from "../../packages/db/client";
import { liteLlmConfig } from "../../packages/litellm/client";
import { runtimeConfig } from "../../packages/runtime/client";
import { createAuth, type Database } from "../control/auth";
import { createInference, routeSnapshot, validateInput, type Endpoint } from "./inference";
import { createAudit, observeSse } from "./audit";
import { auditPolicy } from "../../packages/db/audit";
import { sourceCredentials } from "../../packages/db/source-credentials";
import { registerCodexRelay } from "./codex-relay";
import { registerSubscriptionRelay } from "./subscription-relay";

function publicError(error: unknown) {
  const status = error instanceof ApiError ? error.status : (error as { statusCode?: number })?.statusCode ?? 503;
  const code = error instanceof ApiError ? error.code : status >= 500 ? "gateway_unavailable" : "invalid_request";
  const message = error instanceof ApiError ? error.message : status >= 500 ? "Gateway temporarily unavailable" : "Invalid request";
  return { status, payload: { error: { message, type: code, code, param: null } } };
}

export function registerIngress(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv) {
  if (!env.MINATO_KEY_PEPPER || env.MINATO_KEY_PEPPER.length < 32) {
    throw new Error("Set MINATO_KEY_PEPPER (32+ characters)");
  }
  const auth = createAuth(db, env.MINATO_KEY_PEPPER, "", false);
  const infer = createInference(env, sourceCredentials(db, env));
  const proxy = env.MINATO_DATA_PLANE === "runtime" ? runtimeConfig(env) : liteLlmConfig(env);
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
  registerCodexRelay(app, env);
  registerSubscriptionRelay(app, db, env);
  app.get("/health/ready", async (_request, reply) => {
    const [database, upstream] = await Promise.allSettled([
      db`select 1 from schema_migrations limit 1`,
      fetch(new URL(env.MINATO_DATA_PLANE === "runtime" ? "/healthz" : "/health/liveliness", proxy.base), { headers: proxy.headers, signal: AbortSignal.timeout(2_000) }),
    ]);
    const databaseReady = database.status === "fulfilled";
    const upstreamReady = upstream.status === "fulfilled" && upstream.value.ok;
    const checks = { database: databaseReady, [env.MINATO_DATA_PLANE === "runtime" ? "runtime" : "litellm"]: upstreamReady };
    if (upstream.status === "fulfilled") await upstream.value.body?.cancel();
    return reply.code(databaseReady && upstreamReady ? 200 : 503).send({ ...checks, audit: audit.stats() });
  });
  app.get("/v1/models", async (request) => {
    const identity = await auth.environment(request);
    const rows = await db`select alias from features where environment_id = ${identity.id} and active_version is not null and not unavailable order by alias`;
    return { object: "list", data: rows.map(({ alias }) => ({ id: alias, object: "model", owned_by: "minato" })) };
  });
  app.addContentTypeParser(/^multipart\/form-data\b/i, { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 },
    (_request, body, done) => done(null, body));
  for (const [endpoint, url] of Object.entries(endpointPaths) as [Endpoint, string][]) {
    if (env.MINATO_DATA_PLANE !== "runtime" && runtimeOnlyEndpoint(endpoint)) continue;
    app.post(url, { bodyLimit: uploadEndpoints.has(endpoint) ? 25 * 1024 * 1024 : undefined }, async (request, reply) => {
      if (endpoint === "anthropic-messages" && !request.headers.authorization && typeof request.headers["x-api-key"] === "string") {
        request.headers.authorization = `Bearer ${request.headers["x-api-key"]}`;
      }
      const identity = await auth.environment(request);
      let upload: FormData | undefined;
      let input = request.body;
      if (Buffer.isBuffer(input) && uploadEndpoints.has(endpoint)) {
        try {
          upload = await new Response(input, { headers: { "Content-Type": request.headers["content-type"]! } }).formData();
        } catch {
          throw new ApiError(400, "invalid_upload", "Invalid multipart request");
        }
        input = {
          model: upload.get("model"),
          ...(upload.get("stream") === "true" ? { stream: true } : {}),
          fields: [...new Set(upload.keys())].filter((key) => key !== "model"),
        };
      } else if (uploadEndpoints.has(endpoint) && endpoint !== "image-edit") {
        throw new ApiError(415, "multipart_required", "Send the audio file as multipart/form-data");
      }
      const body = validateInput(input, endpoint);
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
      const rawCorrelation = request.headers["x-minato-correlation-id"];
      const correlationId = typeof rawCorrelation === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(rawCorrelation) ? rawCorrelation : undefined;
      const observed = audit.start({ id: request.id, environmentId: identity.id, snapshot, endpoint, body, policy, correlationId });
      let finalAttempt: string | undefined;
      const start = performance.now();
      try {
        await observed.started;
        const result = await infer({
          snapshot, body, upload, sessionHeader, signal: controller.signal,
          onAttempt: (attempt) => { finalAttempt = attempt.id; observed.record(attempt); },
        });
        if ("stream" in result && result.stream) {
          const stream = observeSse(result.stream, endpoint, policy, observed.streamLimit, (status, detail, usage) => {
            if (finalAttempt && usage) observed.usage(finalAttempt, usage);
            return observed.finish(status, result.status, performance.now() - start, detail);
          });
          return reply.code(result.status).type("text/event-stream; charset=utf-8")
            .header("Cache-Control", "no-cache, no-transform")
            .header("X-Accel-Buffering", "no")
            .send(Readable.fromWeb(stream));
        }
        if ("media" in result && result.media) {
          const stream = Readable.fromWeb(result.media);
          stream.once("end", () => observed.finish("succeeded", result.status, performance.now() - start, { contentType: result.contentType }));
          stream.once("close", () => {
            if (!stream.readableEnded) observed.finish(controller.signal.aborted ? "cancelled" : "failed", result.status, performance.now() - start, null);
          });
          const mime = result.contentType.split(";")[0].trim().toLowerCase();
          const contentType = /^(audio\/[a-z0-9.+-]+|text\/plain)$/.test(mime) ? mime : "application/octet-stream";
          return reply.code(result.status).type(contentType).header("X-Content-Type-Options", "nosniff").send(stream);
        }
        await observed.finish("succeeded", result.status, performance.now() - start, result.payload);
        return reply.code(result.status).send(result.payload);
      } catch (error) {
        const { status, payload } = publicError(error);
        await observed.finish(controller.signal.aborted ? "cancelled" : "failed", status, performance.now() - start, payload);
        throw error;
      }
    });
  }
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook("onReady", async () => {
    if (!env.MINATO_AUDIT_JOURNAL) return;
    const recover = () => void audit.recover()?.catch(() => app.log.error("Audit journal recovery failed"));
    recover();
    recoveryTimer = setInterval(recover, 5000);
  });
  app.addHook("onClose", async () => {
    clearInterval(recoveryTimer);
    await audit.flush();
    audit.close();
  });
}

export function createIngress(db = connectDatabase(), env = process.env) {
  const app = Fastify({ genReqId: () => crypto.randomUUID(), disableRequestLogging: true, logger: true });
  app.register(async (scope) => registerIngress(scope, db, env));
  app.addHook("onClose", () => db.close());
  return app;
}
