import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const revision = "2bf8732b552f48fba4cd1e6519334f3305d22810";
const directory = join(import.meta.dir, "../.runtime/litellm-go");
const origin = "https://github.com/rquanx/litellm-go.git";

async function git(args: string[], capture = false) {
  const process = Bun.spawn(["git", "-C", directory, ...args], { stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
  const output = capture ? await new Response(process.stdout).text() : "";
  if (await process.exited) throw new Error(`Git command failed: ${args[0]}`);
  return output.trim();
}

await mkdir(directory, { recursive: true });
if (!(await Bun.file(join(directory, ".git/HEAD")).exists())) {
  await git(["init", "--initial-branch=minato-runtime"]);
} else if (await git(["status", "--porcelain"], true)) {
  throw new Error("The Runtime checkout contains local changes");
}
await git(["fetch", "--depth=1", origin, revision]);
await git(["checkout", "--detach", revision]);
if (await git(["rev-parse", "HEAD"], true) !== revision) throw new Error("Runtime revision did not match the pin");
