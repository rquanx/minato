import Fastify from "fastify";
import { ZodError } from "zod";
import { ApiError } from "../packages/contracts";
import { connectDatabase } from "../packages/db/client";
import { registerUsageCallback } from "./control/audit";
import { registerControl } from "./control/server";
import { createDashboardListener } from "./control/dashboard";
import { registerIngress } from "./ingress/server";
import { startWorker } from "./worker/runner";

const env = process.env;
const db = connectDatabase();
const app = Fastify({
  genReqId: () => crypto.randomUUID(),
  logger: { level: env.MINATO_LOG_LEVEL ?? "info" },
  disableRequestLogging: true,
});
const callbacks = Fastify({ bodyLimit: 16 * 1024 });
const dashboard = createDashboardListener(db, env);
app.register(async (scope) => registerControl(scope, db, env));
app.register(async (scope) => registerIngress(scope, db, env));
registerUsageCallback(callbacks, db, env);
callbacks.setErrorHandler((error, _request, reply) => {
  if (error instanceof ApiError) return reply.code(error.status).send({ code: error.code });
  if (error instanceof ZodError) return reply.code(422).send({ code: "invalid_usage" });
  const status = (error as { statusCode?: number }).statusCode;
  return reply.code(status && status < 500 ? status : 500).send();
});

let stopWorker: (() => Promise<void>) | undefined;
let closing: Promise<void> | undefined;
function close() {
  return closing ??= (async () => {
    try {
      await Promise.allSettled([app.close(), stopWorker?.()]);
    } finally {
      try { await Promise.allSettled([callbacks.close(), dashboard?.close()]); }
      finally { await db.close(); }
    }
  })();
}
try {
  await callbacks.listen({
    host: env.MINATO_CALLBACK_HOST ?? "127.0.0.1",
    port: Number(env.MINATO_CALLBACK_PORT ?? 4101),
  });
  await app.listen({ host: env.MINATO_HOST ?? "127.0.0.1", port: Number(env.MINATO_PORT ?? 4100) });
  await dashboard?.listen({ host: env.MINATO_HOST ?? "127.0.0.1", port: Number(env.MINATO_DASHBOARD_PORT ?? 4102) });
  stopWorker = startWorker(db, env, (job) => app.log.error({ job }, "Background job failed"));
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
} catch (error) {
  await close();
  throw error;
}
