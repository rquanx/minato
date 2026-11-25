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
  const project = page.getByLabel("Project", { exact: true });
  const releaseProject = project.getByRole("option", { name: process.env.MINATO_SMOKE_PROJECT_NAME ?? "Release sample", exact: true }).first();
  await releaseProject.waitFor({ state: "attached" });
  const releaseId = await releaseProject.getAttribute("value");
  assert(releaseId);
  await project.selectOption(releaseId);
  const environment = page.getByLabel("Environment", { exact: true });
  await environment.getByRole("option", { name: "Production", exact: true }).waitFor({ state: "attached" });
  const releaseEnvironment = await environment.inputValue();
  const suffix = crypto.randomUUID().slice(0, 8);
  await page.getByLabel("Project slug").fill("browser-" + suffix);
  const createProject = page.locator("section").filter({ has: page.getByRole("heading", { name: "Create project" }) });
  const browserLabel = "Browser fixture " + suffix;
  await createProject.getByLabel("Display name").fill(browserLabel);
  await createProject.getByRole("button", { name: "Create project" }).click();
  const browserOption = await project.getByRole("option", { name: browserLabel, exact: true }).getAttribute("value");
  assert(browserOption);
  await project.selectOption(browserOption);
  await page.getByLabel("Environment slug").fill("test");
  const createEnvironment = page.locator("section").filter({ has: page.getByRole("heading", { name: "Create environment" }) });
  await createEnvironment.getByLabel("Display name").fill("Browser environment");
  await createEnvironment.getByRole("button", { name: "Create environment" }).click();
  await page.getByLabel("Key label").fill("Browser fixture key");
  await page.getByRole("button", { name: "Issue key" }).click();
  await page.getByRole("button", { name: "Copy key" }).waitFor();
  await page.getByRole("button", { name: "Model sources" }).click();
  await page.getByLabel("Source slug").fill("browser-" + suffix);
  await page.getByLabel("Directory URL").fill("http://host.docker.internal:18765/primary/v1/models");
  await page.getByLabel("Inference API base").fill("http://host.docker.internal:18765/primary/v1");
  await page.getByLabel("Credential environment variable").fill("MINATO_UPSTREAM_RELEASE_FIXTURE");
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("button", { name: "Sync browser-" + suffix }).click();
  await page.getByText("Directory sync queued.").waitFor();
  await project.selectOption(releaseId);
  await environment.selectOption(releaseEnvironment);
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await page.getByText("Known tokens", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Daily estimated cost (UTC)" }).waitFor();
  if (process.env.MINATO_SMOKE_EXPECT_PRICED_USAGE === "true") {
    await page.getByRole("cell", { name: /^\$0\.0*[1-9]/ }).first().waitFor();
  }
  await page.getByLabel("Call type").selectOption("production");
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
  await page.getByRole("heading", { name: "Original response", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Test response", exact: true }).waitFor();
  console.log("Verified browser login, project/environment creation, environment keys, source sync, cost trends, clipboard and replay.");
} finally {
  await browser.close();
}
