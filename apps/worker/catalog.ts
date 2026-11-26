import type { connectDatabase } from "../../packages/db/client";
import { catalogFailure, readCatalog } from "../../packages/litellm/catalog";
import { recordModelEvent, type ModelChange } from "../../packages/db/model-notifications";
import { readSourceCredential } from "../../packages/db/source-credentials";

export async function syncNextSource(db: ReturnType<typeof connectDatabase>, env = process.env) {
  const token = crypto.randomUUID();
  const [source] = await db`update sources s set lease_token = ${token},
    lease_until = now() + interval '30 seconds', sync_state = 'running'
    from (select id, sync_state from sources where enabled and directory_enabled and next_sync_at <= now()
      and (lease_until is null or lease_until < now()) order by next_sync_at limit 1 for update skip locked) as next
    where s.id = next.id returning s.*, next.sync_state as prior_state`;
  if (!source) return false;
  const priorState = source.prior_state;
  try {
    const bundle = source.credential_id ? await readSourceCredential(db, env)(source.slug, source.credential_id, source.directory_url) : undefined;
    const models = await readCatalog(source, env, bundle?.accessToken, bundle);
    await db.begin(async (tx) => {
      const [current] = await tx`select empty_count from sources
        where id = ${source.id} and revision = ${source.revision} and lease_token = ${token} for update`;
      if (!current) return;
      const firstEmpty = models.length === 0 && current.empty_count === 0;
      if (!firstEmpty) {
        const ids = models.map(({ id }) => id);
        const missing = await tx`update source_models set missing_count = missing_count + 1,
          status = case when missing_count >= 1 or ${models.length === 0} then 'removed' else status end
          where source_id = ${source.id} and status = 'listed' and not manual
          and raw_model_id not in (select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb))
          returning raw_model_id as "modelId", status`;
        const changes: ModelChange[] = missing.filter((entry) => entry.status === "removed")
          .map((entry) => ({ kind: "removed", modelId: entry.modelId }));
        if (models.length) {
          const batch = models.map(({ id, metadata }) => ({ raw_model_id: id, reported: metadata }));
          const discovered = await tx`select entry.raw_model_id as "modelId",
            case when m.raw_model_id is null then 'added' when m.status = 'removed' then 'restored' else 'updated' end as kind
            from jsonb_to_recordset(${JSON.stringify(batch)}::text::jsonb) as entry(raw_model_id text, reported jsonb)
            left join source_models m on m.source_id = ${source.id} and m.raw_model_id = entry.raw_model_id
            where m.raw_model_id is null or m.status = 'removed' or m.reported is distinct from entry.reported
            order by entry.raw_model_id`;
          if (source.last_success_at) changes.push(...discovered as ModelChange[]);
          await tx`insert into source_models (source_id, raw_model_id, reported, last_seen_at)
            select ${source.id}, raw_model_id, reported, now()
            from jsonb_to_recordset(${JSON.stringify(batch)}::text::jsonb) as entry(raw_model_id text, reported jsonb)
            on conflict (source_id, raw_model_id) do update set reported = excluded.reported,
              last_seen_at = now(), missing_count = 0, status = 'listed',
              verification = case when source_models.reported is distinct from excluded.reported or source_models.status = 'removed'
                then null else source_models.verification end`;
        }
        if (changes.length || priorState === "stale") {
          await recordModelEvent(tx, source, changes, priorState === "stale" ? "source_recovered" : undefined);
        }
        await tx`update features set reconcile_needed = true where approved_policy is not null`;
      }
      const status = firstEmpty ? "empty_unconfirmed" : "synced";
      await tx`update sources set sync_state = ${status}, empty_count = ${models.length === 0 ? current.empty_count + 1 : 0},
        last_success_at = case when ${firstEmpty} then last_success_at else now() end,
        next_sync_at = now() + (600 + random() * 90) * interval '1 second', lease_token = null, lease_until = null
        where id = ${source.id}`;
      await tx`insert into source_syncs (source_id, status, model_count) values (${source.id}, ${status}, ${models.length})`;
    });
  } catch (error) {
    const failure = catalogFailure(error);
    await db.begin(async (tx) => {
      const [changed] = await tx`update sources set sync_state = 'stale', empty_count = 0, lease_token = null,
        lease_until = null, next_sync_at = now() + interval '1 minute'
        where id = ${source.id} and revision = ${source.revision} and lease_token = ${token} returning id`;
      if (changed) {
        await tx`insert into source_syncs (source_id, status, error_code, http_status)
          values (${source.id}, 'stale', ${failure.code}, ${failure.status ?? null})`;
        if (priorState !== "stale") await recordModelEvent(tx, source, [], "source_stale");
      }
    });
  }
  return true;
}
