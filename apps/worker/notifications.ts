import type { Database } from "../control/auth";
import { postWebhook, webhookTarget } from "../../packages/db/webhooks";

export async function deliverModelEvent(db: Database, env: NodeJS.ProcessEnv) {
  const lease = crypto.randomUUID();
  const [delivery] = await db`with next as (
    select event_id, channel from model_event_deliveries where state = 'pending' and next_attempt_at <= now()
    order by next_attempt_at limit 1 for update skip locked
  )
  update model_event_deliveries d set lease_token = ${lease}, next_attempt_at = now() + interval '30 seconds'
  from next, model_events e where d.event_id = next.event_id and d.channel = next.channel and e.id = d.event_id
  returning d.*, e.source_slug, e.payload, e.created_at`;
  if (!delivery) return false;
  let delivered = false;
  let failure: string | null = null;
  try {
    const target = await webhookTarget(db, env, delivery.channel);
    const status = await postWebhook(target, delivery.event_id, {
      id: delivery.event_id, type: "model.catalog_changed", source: delivery.source_slug,
      createdAt: delivery.created_at, scopes: delivery.scopes, ...delivery.payload,
    });
    delivered = status >= 200 && status < 300;
    if (!delivered) failure = `HTTP ${status}`;
  } catch { failure = "Destination unavailable or misconfigured"; }
  const attempts = delivery.attempts + 1;
  const state = delivered ? "delivered" : attempts >= 5 ? "failed" : "pending";
  await db`update model_event_deliveries set state = ${state}, attempts = ${attempts}, lease_token = null, last_error = ${failure},
    next_attempt_at = now() + ${30 * 2 ** (attempts - 1)} * interval '1 second'
    where event_id = ${delivery.event_id} and channel = ${delivery.channel} and lease_token = ${lease}`;
  return true;
}
