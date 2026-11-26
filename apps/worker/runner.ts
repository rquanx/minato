import { setTimeout as wait } from "node:timers/promises";
import { createLiteLlm } from "../../packages/litellm/client";
import { createRuntime } from "../../packages/runtime/client";
import type { connectDatabase } from "../../packages/db/client";
import { publishNextRoute, retireRuntimeRoutes } from "./routes";
import { reconcileNextFeature } from "./reconcile";
import { syncNextSource } from "./catalog";
import { cleanExpired, createTestRunner } from "./tests";
import { deliverModelEvent } from "./notifications";
import { buildUsageHour, enqueueUsageHours } from "../../packages/db/usage-hours";
import { cleanSupersededCredentials, refreshSourceCredential, sourceCredentials } from "../../packages/db/source-credentials";

export function startWorker(db: ReturnType<typeof connectDatabase>, env: NodeJS.ProcessEnv,
  logError: (job: string) => void) {
  const resolveCredential = sourceCredentials(db, env);
  const proxy = env.MINATO_DATA_PLANE === "runtime" ? createRuntime(env, resolveCredential) : createLiteLlm(env, resolveCredential);
  const stop = new AbortController();

  async function run(name: string, task: () => Promise<boolean | void>, interval: number) {
    while (!stop.signal.aborted) {
      try {
        if (await task()) continue;
      } catch {
        logError(name);
      }
      await wait(interval, undefined, { signal: stop.signal }).catch((error) => {
        if (!stop.signal.aborted) throw error;
      });
    }
  }

  const loops = [
    run("publish", () => publishNextRoute(db, proxy), 500),
    run("sync", () => syncNextSource(db, env), 500),
    run("notify", () => deliverModelEvent(db, env), 2000),
    run("schedule-usage", () => enqueueUsageHours(db), 60_000),
    run("summarize-usage", async () => { await buildUsageHour(db); }, 250),
    run("reconcile", () => reconcileNextFeature(db), 500),
    run("test", createTestRunner(db, proxy, { ...env, MINATO_AUDIT_JOURNAL: undefined }), 500),
    run("cleanup", () => cleanExpired(db), 60_000),
    run("cleanup-credentials", () => cleanSupersededCredentials(db), 3_600_000),
    run("refresh-credentials", () => refreshSourceCredential(db, env), 5000),
    ...("remove" in proxy ? [run("retire-routes", () => retireRuntimeRoutes(db, proxy), 60_000)] : []),
  ];
  return async () => {
    stop.abort();
    await Promise.all(loops);
  };
}
