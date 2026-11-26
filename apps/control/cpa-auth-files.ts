import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, uuid } from "../../packages/contracts";
import { validateUrl } from "../../packages/litellm/catalog";
import type { Database } from "./auth";

const sourceId = z.object({ id: uuid });
const filename = z.string().regex(/^[\p{L}\p{N}_+-][\p{L}\p{N} _.@+-]{0,199}\.json$/iu);
const upload = z.strictObject({ name: filename, content: z.string().min(2).max(262_144) });
const files = z.object({ files: z.array(z.object({
  name: z.string(), provider: z.string().optional(), status: z.string().optional(), disabled: z.boolean().optional(),
})) });

export function cpaManagement(slug: string, env: NodeJS.ProcessEnv) {
  const suffix = slug.toUpperCase().replaceAll("-", "_");
  const base = env["MINATO_CPA_MANAGEMENT_URL_" + suffix];
  const key = env["MINATO_CPA_MANAGEMENT_KEY_" + suffix];
  if (!base || !key) return;
  return { base, key };
}

export function registerCpaAuthFiles(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv) {
  async function management(id: string) {
    const [source] = await db`select slug from sources where id = ${id} and kind = 'cpa'`;
    const config = source && cpaManagement(source.slug, env);
    if (!config) throw new ApiError(404, "cpa_management_unavailable", "CPA management is not configured for this source");
    try {
      const base = validateUrl(config.base);
      if (!["http:", "https:"].includes(base.protocol) || base.search) throw new Error();
      const url = new URL("/v0/management/auth-files", base);
      return { url, headers: { authorization: "Bearer " + config.key } };
    } catch {
      throw new ApiError(503, "cpa_management_invalid", "Check the configured CPA management URL");
    }
  }
  async function request(url: URL, headers: Record<string, string>, body?: string) {
    try {
      const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers, body,
        redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (response.ok) return response;
      await response.body?.cancel();
    } catch { /* Keep CPA responses and credentials out of the control API. */ }
    throw new ApiError(502, "cpa_management_error", "CPA management request failed. Check connectivity and the management key");
  }
  async function list(target: Awaited<ReturnType<typeof management>>) {
    const response = await request(target.url, target.headers);
    const result = files.safeParse(await response.json().catch(() => null));
    if (!result.success) throw new ApiError(502, "cpa_invalid_auth_files", "CPA returned an invalid authentication file list");
    return result.data.files;
  }
  const path = "/admin/v1/sources/:id/cpa-auth-files";
  const imports = new Set<string>();
  app.get(path, async (req, reply) => {
    const target = await management(sourceId.parse(req.params).id);
    return reply.header("Cache-Control", "no-store").send(await list(target));
  });
  app.post(path, { bodyLimit: 600_000 }, async (req, reply) => {
    const { id } = sourceId.parse(req.params);
    const target = await management(id);
    const { name, content } = upload.parse(req.body);
    let credential: unknown;
    try { credential = JSON.parse(content); } catch { credential = null; }
    if (!credential || typeof credential !== "object" || Array.isArray(credential) || Buffer.byteLength(content) > 262_144) {
      throw new ApiError(422, "invalid_auth_file", "Select one JSON object file up to 256 KiB");
    }
    const sameFile = target.url.href + "/" + name.toLowerCase();
    if (imports.has(sameFile)) throw new ApiError(409, "auth_file_exists", "A file with this name is being imported");
    imports.add(sameFile);
    try {
      if ((await list(target)).some((file) => file.name.toLowerCase() === name.toLowerCase())) {
        throw new ApiError(409, "auth_file_exists", "CPA already has an authentication file with this name");
      }
      target.url.searchParams.set("name", name);
      const response = await request(target.url, { ...target.headers, "content-type": "application/json" }, content);
      await response.body?.cancel();
      const queued = await db`update sources set next_sync_at = now() where id = ${id} and enabled and directory_enabled returning id`;
      return reply.code(201).send({ name, syncQueued: queued.length > 0 });
    } finally {
      imports.delete(sameFile);
    }
  });
}
