import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, uuid } from "../../packages/contracts";
import { auditCipher, auditPolicy } from "../../packages/db/audit";
import { saveUsage } from "../../packages/db/usage";
import type { Database } from "./auth";
import { callSearch, searchCalls } from "../../packages/db/call-search";
import { readUsage, usageRange } from "../../packages/db/usage-report";

const idPath = z.object({ id: uuid });
export function registerUsageCallback(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  app.post("/internal/v1/litellm/usage", async (request, reply) => {
    const secret = env.MINATO_CALLBACK_SECRET;
    if (!secret || secret.length < 32 || !timingSafeEqual(
      digest(request.headers.authorization ?? ""), digest(`Bearer ${secret}`),
    )) throw new ApiError(401, "invalid_callback_token", "Invalid callback token");
    const input = z.strictObject({ attemptId: uuid, usage: z.unknown() }).parse(request.body);
    await saveUsage(db, input.attemptId, input.usage);
    return reply.code(204).send();
  });
}

export function registerAudit(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv) {
  const cipher = auditCipher(env);
  app.get("/admin/v1/environments/:id/audit-policy", async (request) => {
    const { id } = idPath.parse(request.params);
    const [row] = await db`select audit_enabled as enabled, audit_days as "retentionDays",
      audit_limit as "contentLimit", audit_redact as "redactKeys", settings_revision as revision
      from environments where id = ${id}`;
    if (!row) throw new ApiError(404, "environment_not_found", "Environment not found");
    return row;
  });
  app.put("/admin/v1/environments/:id/audit-policy", async (request) => {
    const { id } = idPath.parse(request.params);
    const input = auditPolicy.extend({ expectedRevision: z.number().int().nonnegative() }).parse(request.body);
    if (input.enabled && !cipher) throw new ApiError(422, "audit_key_required", "Configure MINATO_AUDIT_SECRET first");
    return db.begin(async (tx) => {
      const [updated] = await tx`update environments set audit_enabled = ${input.enabled}, audit_days = ${input.retentionDays},
        audit_limit = ${input.contentLimit}, audit_redact = ${JSON.stringify(input.redactKeys)}::text::jsonb,
        settings_revision = settings_revision + 1 where id = ${id} and settings_revision = ${input.expectedRevision}
        returning settings_revision as revision`;
      if (!updated) throw new ApiError(409, "stale_audit_policy", "Audit policy has changed");
      await tx`insert into admin_events (actor, action, entity_id) values ('admin', 'audit.policy_changed', ${id})`;
      return updated;
    });
  });
  app.get("/admin/v1/environments/:id/calls", async (request) => {
    const { id } = idPath.parse(request.params);
    return searchCalls(db, id, callSearch.parse(request.query));
  });
  app.get("/admin/v1/calls/:id", async (request) => {
    const { id } = idPath.parse(request.params);
    const [call] = await db`select c.*, f.alias from calls c join features f on c.feature_id = f.id where request_id = ${id}`;
    if (!call) throw new ApiError(404, "call_not_found", "Call not found");
    const attempts = await db`select a.*, u.input_tokens::text, u.output_tokens::text, u.total_tokens::text,
      u.cached_tokens::text, u.reasoning_tokens::text from call_attempts a left join attempt_usage u on a.id = u.attempt_id
      where a.request_id = ${id} order by a.captured_at, a.id`;
    return { ...call, attempts };
  });
  app.get("/admin/v1/calls/:id/content", async (request, reply) => {
    const { id } = idPath.parse(request.params);
    const [call] = await db`select capture_state from calls where request_id = ${id}`;
    if (!call) throw new ApiError(404, "call_not_found", "Call not found");
    const details = await db`select kind, sealed, capture_state from call_content where request_id = ${id} and expires_at > now()`;
    const content = details.map((part) => ({
      kind: part.kind, state: cipher ? part.capture_state : "unavailable",
      value: cipher ? JSON.parse(cipher.open(part.sealed, `${id}:${part.kind}`)) : null,
    }));
    await db`insert into admin_events (actor, action, entity_id) values ('admin', 'audit.content_read', ${id})`;
    return reply.header("Cache-Control", "no-store").send({ state: call.capture_state, content });
  });
  app.delete("/admin/v1/calls/:id/content", async (request, reply) => {
    const { id } = idPath.parse(request.params);
    await db.begin(async (tx) => {
      const [call] = await tx`update calls set capture_state = 'expired' where request_id = ${id} returning request_id`;
      if (!call) throw new ApiError(404, "call_not_found", "Call not found");
      await tx`delete from call_content where request_id = ${id}`;
      await tx`insert into admin_events (actor, action, entity_id) values ('admin', 'audit.content_deleted', ${id})`;
    });
    return reply.code(204).send();
  });
  app.get("/admin/v1/environments/:id/usage", async (request) => {
    const { id } = idPath.parse(request.params);
    return readUsage(db, id, usageRange.parse(request.query));
  });
  app.get("/admin/v1/projects/:id/usage", async (request) => {
    const { id } = idPath.parse(request.params);
    const [project] = await db`select id from projects where id = ${id} and archived_at is null`;
    if (!project) throw new ApiError(404, "project_not_found", "Project not found");
    return readUsage(db, id, usageRange.parse(request.query), { project: true });
  });
}
