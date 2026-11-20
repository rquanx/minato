import { setTimeout as wait } from "node:timers/promises";
import { createLiteLlm } from "../../packages/litellm/client";
import { createRuntime } from "../../packages/runtime/client";
import type { connectDatabase } from "../../packages/db/client";
import { publishNextRoute } from "./routes";
import { reconcileNextFeature } from "./reconcile";
import { syncNextSource } from "./catalog";
import { cleanExpired, createTestRunner } from "./tests";

export function startWorker(db: ReturnType<typeof connectDatabase>, env: NodeJS.ProcessEnv,
  logError: (job: string) => void) {
  const proxy = env.MINATO_DATA_PLANE === "runtime" ? createRuntime(env) : createLiteLlm(env);
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
    run("sync", () => syncNextSource(db), 500),
    run("reconcile", () => reconcileNextFeature(db), 500),
    run("test", createTestRunner(db, proxy, env), 500),
    run("cleanup", () => cleanExpired(db), 60_000),
  ];
  return async () => {
    stop.abort();
    await Promise.all(loops);
  };
}
