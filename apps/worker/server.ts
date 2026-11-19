import { connectDatabase } from "../../packages/db/client";
import { createLiteLlm } from "../../packages/litellm/client";
import { publishNextRoute } from "./routes";
import { reconcileNextFeature } from "./reconcile";
import { syncNextSource } from "./catalog";
import { cleanExpired, createTestRunner } from "./tests";

const db = connectDatabase();
const proxy = createLiteLlm();
const runTest = createTestRunner(db, proxy);
let running = true;
let nextCleanup = 0;
process.once("SIGINT", () => { running = false; });
process.once("SIGTERM", () => { running = false; });
try {
  while (running) {
    try {
      const routes = await publishNextRoute(db, proxy);
      const sources = await syncNextSource(db);
      const reconciled = await reconcileNextFeature(db);
      const tested = await runTest();
      if (Date.now() >= nextCleanup) {
        await cleanExpired(db);
        nextCleanup = Date.now() + 60_000;
      }
      if (routes || sources || reconciled || tested) continue;
    } catch {
      console.error("Route worker could not poll Postgres");
    }
    await Bun.sleep(500);
  }
} finally {
  await db.close();
}
