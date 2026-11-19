import { createAudit } from "../ingress/audit";
import { createInference, routeSnapshot, validateInput } from "../ingress/inference";
import { auditCipher, capture } from "../../packages/db/audit";
import { ApiError, endpoint } from "../../packages/contracts";
import type { connectDatabase } from "../../packages/db/client";
import { previewCandidates } from "../../packages/db/routing-policy";
import type { createLiteLlm } from "../../packages/litellm/client";
import { testTarget } from "../control/tests";

export function createTestRunner(db: ReturnType<typeof connectDatabase>, proxy: ReturnType<typeof createLiteLlm>, env = process.env) {
  const cipher = auditCipher(env);
  const infer = createInference(env);
  const audit = createAudit(db, env);
  return async function runNextTest() {
    const [test] = await db`update tests t set status = 'running', started_at = now()
      from (select id from tests where status = 'queued' and expires_at > now()
        order by created_at limit 1 for update skip locked) as next where t.id = next.id returning t.*`;
    if (!test) return false;
    const started = performance.now();
    let record: ReturnType<typeof audit.start> | undefined;
    try {
      if (!cipher || !test.input_sealed) throw new ApiError(503, "input_unavailable", "Test input unavailable");
      const [feature] = await db`select f.id, f.alias, f.environment_id, f.declaration, f.unavailable,
        f.active_version::text as version, r.candidates, r.requirements
        from features f left join route_versions r on (f.id, f.active_version) = (r.feature_id, r.version)
        join environments e on e.id = f.environment_id join projects p on e.project_id = p.id
        where f.id = ${test.feature_id} and f.environment_id = ${test.environment_id}
        and e.archived_at is null and p.archived_at is null`;
      if (!feature) throw new ApiError(404, "feature_not_found", "Feature unavailable");
      const target = testTarget.parse(test.target);
      if (test.actor) {
        const [grant] = await db`select can_test, can_content from environment_memberships
          where environment_id = ${test.environment_id} and member_id = ${test.actor}`;
        if (!grant?.can_test || (test.replay_of && !grant.can_content)) {
          throw new ApiError(403, "test_permission_revoked", "Environment test permission is required");
        }
      }
      let groupOverride: string | undefined;
      if (target.mode === "specific_model") {
        if (test.actor && !feature.candidates?.some((item: { sourceId: string; modelId: string }) =>
          item.sourceId === target.sourceId && item.modelId === target.modelId)) {
          throw new ApiError(403, "test_model_not_allowed", "The model is outside the active route for this feature");
        }
        const selection = await previewCandidates(db, feature, { primary: target, fallbacks: [] });
        const chosen = selection.candidates.find((entry) => entry.modelId === target.modelId && entry.sourceId === target.sourceId);
        if (!chosen) throw new ApiError(422, "test_model_unavailable", "Test model is not eligible");
        groupOverride = `minato-test-${test.id}`;
        await proxy.stage(groupOverride, chosen);
        feature.candidates = [chosen];
        feature.version ??= "0";
        feature.requirements = selection.requirements;
      } else if (feature.unavailable || !feature.version) {
        throw new ApiError(503, "no_active_route", "Feature has no active route");
      }
      const snapshot = routeSnapshot.parse(feature);
      const path = endpoint.parse(test.endpoint);
      if (snapshot.requirements.endpoint !== path) throw new ApiError(422, "endpoint_mismatch", "Target requires a different endpoint");
      const body = validateInput(JSON.parse(cipher.open(test.input_sealed, test.id)), path);
      const policy = { enabled: false, retentionDays: 1, contentLimit: 262144, redactKeys: [] };
      record = audit.start({ id: test.id, environmentId: test.environment_id, snapshot, endpoint: path,
        body, policy, kind: test.replay_of ? "replay" : "test" });
      let actualModel: string | undefined;
      const result = await infer({ snapshot, body, groupOverride, signal: AbortSignal.timeout(120_000),
        onAttempt: (entry) => { actualModel = entry.modelId; record!.record(entry); } });
      if ("stream" in result) throw new Error("Unexpected streaming test response");
      record.finish("succeeded", result.status, performance.now() - started, null);
      const output = capture({ response: result.payload, actualModel, durationMs: Math.round(performance.now() - started) }, policy);
      await db`update tests set status = 'succeeded', output_sealed = ${cipher.seal(output.text, test.id)}
        where id = ${test.id}`;
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "test_execution_failed";
      const httpStatus = error instanceof ApiError ? error.status : 502;
      const status = record && (httpStatus === 502 || httpStatus === 504) ? "unknown" : "failed";
      record?.finish(status, httpStatus, performance.now() - started, null);
      await db`update tests set status = ${status}, error_code = ${code} where id = ${test.id}`;
    } finally {
      await audit.flush();
    }
    return true;
  };
}

export async function cleanExpired(db: ReturnType<typeof connectDatabase>) {
  await db.begin(async (tx) => {
    await tx`update tests set status = 'unknown' where status = 'running' and started_at < now() - interval '4 minutes'`;
    await tx`update tests set input_sealed = null, output_sealed = null
      where expires_at <= now() and (input_sealed is not null or output_sealed is not null)`;
    await tx`update calls set status = 'unknown' where status = 'started' and started_at < now() - interval '4 minutes'`;
    await tx`with expired as (delete from call_content where expires_at <= now() returning request_id)
      update calls set capture_state = 'expired' where request_id in (select request_id from expired)`;
    await tx`delete from attempt_usage where received_at < now() - interval '90 days'`;
    await tx`delete from calls where started_at < now() - interval '90 days'`;
  });
}
