import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, endpoint, modelReference, uuid } from "../../packages/contracts";
import { auditCipher } from "../../packages/db/audit";
import { validateInput } from "../ingress/inference";
import type { Database } from "./auth";

export const testTarget = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("active_route") }),
  modelReference.extend({ mode: z.literal("specific_model") }),
]);
const testInput = z.strictObject({
  featureId: uuid, replayOf: uuid.optional(), endpoint,
  request: z.record(z.string(), z.unknown()), target: testTarget,
});
const idPath = z.object({ id: uuid });

export function registerTests(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv) {
  const cipher = auditCipher(env);
  app.post("/admin/v1/environments/:id/tests", async (request, reply) => {
    if (!cipher) throw new ApiError(503, "test_storage_unavailable", "Configure MINATO_AUDIT_SECRET");
    const { id } = idPath.parse(request.params);
    const input = testInput.parse(request.body);
    const idempotency = z.string().min(8).max(160).parse(request.headers["idempotency-key"]);
    const [feature] = await db`select alias from features where id = ${input.featureId} and environment_id = ${id}`;
    if (!feature) throw new ApiError(404, "feature_not_found", "Feature not found");
    if (input.replayOf) {
      const [original] = await db`select request_id from calls where request_id = ${input.replayOf}
        and environment_id = ${id} and feature_id = ${input.featureId}`;
      if (!original) throw new ApiError(404, "original_not_found", "Original call not found");
    }
    if (Object.hasOwn(input.request, "previous_response_id") || Object.hasOwn(input.request, "conversation")) {
      throw new ApiError(422, "missing_replay_context", "Replace the remote conversation reference with its messages before replaying");
    }
    const body = validateInput({ ...input.request, model: feature.alias, stream: false }, input.endpoint);
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...input, request: body })).digest("hex");
    const testId = crypto.randomUUID();
    const scopedKey = `${request.memberId ?? "admin"}:${idempotency}`;
    const record = await db.begin(async (tx) => {
      const [created] = await tx`insert into tests
        (id, environment_id, feature_id, replay_of, actor, idempotency_key, fingerprint, endpoint, target, input_sealed)
        values (${testId}, ${id}, ${input.featureId}, ${input.replayOf ?? null}, ${request.memberId}, ${scopedKey}, ${fingerprint},
          ${input.endpoint}, ${JSON.stringify(input.target)}::text::jsonb, ${cipher.seal(JSON.stringify(body), testId)})
        on conflict (environment_id, idempotency_key) do nothing returning id, status, fingerprint`;
      if (created) return created;
      const [previous] = await tx`select id, status, fingerprint from tests
        where environment_id = ${id} and idempotency_key = ${scopedKey}`;
      if (previous.fingerprint !== fingerprint) throw new ApiError(409, "idempotency_conflict", "Request differs for this idempotency key");
      return previous;
    });
    return reply.code(202).send({ id: record.id, status: record.status });
  });
  app.get("/admin/v1/tests/:id", async (request, reply) => {
    const { id } = idPath.parse(request.params);
    const [test] = await db`select id, status, replay_of as "replayOf", error_code as "errorCode",
      created_at as "createdAt", case when expires_at > now() then output_sealed end as output
      from tests where id = ${id}`;
    if (!test) throw new ApiError(404, "test_not_found", "Test not found");
    return reply.header("Cache-Control", "no-store").send({
      ...test, output: test.output && cipher ? JSON.parse(cipher.open(test.output, test.id)) : null,
    });
  });
}
