import Fastify from "fastify";
import { z, ZodError } from "zod";
import { ApiError } from "../../packages/contracts";
import { connectDatabase } from "../../packages/db/client";
import { createAuth } from "./auth";
import { registerFeatures } from "./features";
import { registerProjects } from "./projects";
import { registerRoutes } from "./routes";
import { registerCatalog } from "./catalog";
import { registerAudit } from "./audit";
import { registerTests } from "./tests";
import { authorizeMember, registerMembers } from "./members";

export function createControl(db = connectDatabase(), env = process.env) {
  const password = env.MINATO_ADMIN_PASSWORD;
  const pepper = env.MINATO_KEY_PEPPER;
  if (!password || password.length < 12 || !pepper || pepper.length < 32) {
    throw new Error("Set MINATO_ADMIN_PASSWORD (12+ characters) and MINATO_KEY_PEPPER (32+ characters)");
  }
  const app = Fastify({ logger: { level: env.MINATO_LOG_LEVEL ?? "info" }, disableRequestLogging: true });
  const auth = createAuth(db, pepper, password, env.MINATO_COOKIE_SECURE !== "false");
  app.decorateRequest("memberId", null);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ code: error.code, message: error.message, requestId: request.id });
    if (error instanceof ZodError) return reply.code(422).send({
      code: "invalid_input", message: "Request validation failed", requestId: request.id,
      details: error.issues.map(({ path, code }) => ({ path, code })),
    });
    const failure = error as { code?: string; statusCode?: number };
    if (failure.code === "23505" || (error as { errno?: string }).errno === "23505") {
      return reply.code(409).send({ code: "already_exists", message: "Resource already exists", requestId: request.id });
    }
    if (failure.statusCode && failure.statusCode < 500) {
      return reply.code(failure.statusCode).send({ code: "invalid_request", message: "Invalid HTTP request", requestId: request.id });
    }
    request.log.error({ code: failure.code }, "Control request failed");
    return reply.code(500).send({ code: "internal_error", message: "Request could not be completed", requestId: request.id });
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await db`select 1 from schema_migrations limit 1`;
      return { database: "ready" };
    } catch {
      return reply.code(503).send({ database: "unavailable" });
    }
  });
  app.addHook("onClose", () => db.close());
  app.addHook("preHandler", async (request) => {
    const path = request.routeOptions.url ?? "";
    if (!path.startsWith("/admin/v1/")) return;
    const write = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const origin = request.headers.origin;
    const expected = env.MINATO_PUBLIC_ORIGIN ?? `${request.protocol}://${request.host}`;
    if (write && origin && origin !== expected) throw new ApiError(403, "invalid_origin", "Origin does not match");
    if (path === "/admin/v1/session" && request.method === "POST") return;
    const session = await auth.admin(request);
    if (write && request.headers["x-csrf-token"] !== session.csrfToken) {
      throw new ApiError(403, "invalid_csrf_token", "CSRF token does not match");
    }
    if (session.memberId) await authorizeMember(db, request, session.memberId);
    request.memberId = session.memberId;
  });

  app.post("/admin/v1/session", async (request, reply) => {
    const input = z.strictObject({ password: z.string().max(1024), username: z.string().min(1).max(48).optional() }).parse(request.body);
    const cookie = await auth.login(input.password, input.username);
    return reply.header("Set-Cookie", cookie).header("Cache-Control", "no-store").code(204).send();
  });
  app.get("/admin/v1/session", async (request, reply) => {
    const { csrfToken, memberId } = await auth.admin(request);
    return reply.header("Cache-Control", "no-store").send({ csrfToken, memberId });
  });
  app.delete("/admin/v1/session", async (request, reply) => {
    const { session } = await auth.admin(request);
    return reply.header("Set-Cookie", await auth.logout(session)).code(204).send();
  });
  registerProjects(app, db, auth);
  registerFeatures(app, db, auth);
  registerRoutes(app, db);
  registerCatalog(app, db);
  registerAudit(app, db, env);
  registerTests(app, db, env);
  registerMembers(app, db);
  const webDirectory = new URL("../web/dist/", import.meta.url);
  app.get("/", async (_request, reply) => {
    const index = Bun.file(new URL("index.html", webDirectory));
    if (!(await index.exists())) return reply.code(404).send({ message: "Run bun run build:web to build the console" });
    return reply.type("text/html; charset=utf-8").send(Buffer.from(await index.arrayBuffer()));
  });
  app.get("/assets/:file", async (request, reply) => {
    const { file } = z.object({ file: z.string().regex(/^[a-zA-Z0-9_.-]+\.(?:js|css)$/) }).parse(request.params);
    const asset = Bun.file(new URL("assets/" + file, webDirectory));
    if (!(await asset.exists())) return reply.code(404).send();
    return reply.type(asset.type).header("Cache-Control", "public, max-age=31536000, immutable")
      .send(Buffer.from(await asset.arrayBuffer()));
  });
  return app;
}

declare module "fastify" {
  interface FastifyRequest { memberId: string | null; }
}

if (import.meta.main) {
  const app = createControl();
  process.once("SIGINT", () => void app.close());
  process.once("SIGTERM", () => void app.close());
  await app.listen({ host: process.env.MINATO_HOST ?? "127.0.0.1", port: Number(process.env.MINATO_PORT ?? 4100) });
}
