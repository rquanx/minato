import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const origin = process.env.MINATO_SMOKE_ORIGIN ?? "http://127.0.0.1:18088";
const password = process.env.MINATO_SMOKE_PASSWORD;
if (!password) throw new Error("Set MINATO_SMOKE_PASSWORD");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open console" }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  const releaseProject = process.env.MINATO_SMOKE_PROJECT_NAME ?? "Release sample";
  async function choose(label: string, option: string) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).first().click();
  }
  await choose("Project", releaseProject);
  await choose("Environment", "Production");
  const suffix = crypto.randomUUID().slice(0, 8);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project slug").fill("browser-" + suffix);
  const createProject = page.getByRole("dialog", { name: "Create project" });
  const browserLabel = "Browser fixture " + suffix;
  await createProject.getByLabel("Display name").fill(browserLabel);
  await createProject.getByRole("button", { name: "Create project" }).click();
  await choose("Project", browserLabel);
  await page.getByRole("button", { name: "New environment", exact: true }).click();
  await page.getByLabel("Environment slug").fill("test");
  const createEnvironment = page.getByRole("dialog", { name: "Create environment" });
  await createEnvironment.getByLabel("Display name").fill("Browser environment");
  await createEnvironment.getByRole("button", { name: "Create environment" }).click();
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("button", { name: "Environment keys" }).click();
  await page.getByLabel("Key label").fill("Browser fixture key");
  await page.getByRole("button", { name: "Issue key" }).click();
  await page.getByRole("button", { name: "Copy key" }).waitFor();
  await page.getByRole("button", { name: "Model sources" }).click();
  await page.getByRole("button", { name: "New source", exact: true }).click();
  await page.getByLabel("Source slug").fill("browser-" + suffix);
  await page.getByLabel("Directory URL").fill("http://host.docker.internal:18765/primary/v1/models");
  await page.getByLabel("Inference API base").fill("http://host.docker.internal:18765/primary/v1");
  await page.getByLabel("Credential environment variable").fill("MINATO_UPSTREAM_RELEASE_FIXTURE");
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("searchbox", { name: "Search sources" }).fill("browser-" + suffix);
  await page.getByRole("button", { name: "Sync browser-" + suffix }).click();
  await page.getByText("Directory sync queued.").waitFor();
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await choose("Project", releaseProject);
  await choose("Environment", "Production");
  await page.getByRole("group", { name: "Known tokens" }).waitFor();
  await page.getByRole("group", { name: "Estimated cost (USD)" }).waitFor();
  await page.getByRole("button", { name: "Daily breakdown", exact: true }).click();
  if (process.env.MINATO_SMOKE_EXPECT_PRICED_USAGE === "true") {
    await page.getByRole("cell", { name: /^\$0\.0*[1-9]/ }).first().waitFor();
  }
  await page.getByRole("button", { name: "Calls", exact: true }).click();
  await choose("Call type", "Production");
  await page.getByRole("row").filter({ hasText: "production" }).last().getByRole("button", { name: /Open call/ }).click();
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard, "Synthetic deployment sample.");
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await page.getByRole("heading", { name: "Replay request", exact: true }).waitFor();
  const replayCreated = page.waitForResponse((response) => response.request().method() === "POST" &&
    /\/environments\/[^/]+\/tests$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  const replayResponse = await replayCreated;
  assert.equal(replayResponse.status(), 202, await replayResponse.text());
  await page.getByText("succeeded", { exact: true }).waitFor();
  await page.getByText("Original response", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Test response", exact: true }).waitFor();
  console.log("Verified browser login, project/environment creation, environment keys, source sync, cost trends, clipboard and replay.");
} finally {
  await browser.close();
}
