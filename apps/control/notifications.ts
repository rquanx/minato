import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, uuid } from "../../packages/contracts";
import { notificationChannels } from "../../packages/db/model-notifications";
import { auditCipher } from "../../packages/db/audit";
import { postWebhook, webhookTarget, webhookUrl } from "../../packages/db/webhooks";
import type { Database } from "./auth";

const settingsPath = "/admin/v1/notifications/settings";
const scopeQuery = z.object({ scope: z.enum(["global", "project", "environment"]), id: uuid.optional() })
  .refine(({ scope, id }) => scope === "global" || !!id);

export function registerNotifications(app: FastifyInstance, db: Database, env: NodeJS.ProcessEnv) {
  const deployed = notificationChannels(env);
  const cipher = auditCipher(env);
  const webhookInput = z.strictObject({ name: z.string().trim().min(1).max(80), url: z.string().max(2048).optional() });
  const webhooksPath = "/admin/v1/notifications/webhooks";
  const listWebhooks = async () => [
    ...deployed.map((id) => {
      let hostname = "";
      try { hostname = webhookUrl(env[id]!).host; } catch { /* Show a misconfigured deployment channel. */ }
      return { id, name: id.slice("MINATO_NOTIFY_WEBHOOK_".length), hostname, managed: false };
    }),
    ...await db`select 'webhook:' || id as id, name, hostname, true as managed from notification_webhooks order by created_at desc`,
  ];
  const parseUrl = (value: string) => {
    try { return webhookUrl(value); }
    catch { throw new ApiError(422, "invalid_webhook_url", "Enter a valid HTTPS Webhook URL"); }
  };
  app.get(webhooksPath, async (_request, reply) => reply.header("Cache-Control", "no-store").send(await listWebhooks()));
  app.post(webhooksPath, async (request, reply) => {
    if (!cipher) throw new ApiError(409, "webhook_storage_unavailable", "Configure MINATO_AUDIT_SECRET to store Webhook URLs");
    const input = webhookInput.required({ url: true }).parse(request.body);
    const url = parseUrl(input.url);
    const id = crypto.randomUUID();
    await db`insert into notification_webhooks (id, name, hostname, sealed_url)
      values (${id}, ${input.name}, ${url.host}, ${cipher.seal(url.href, `webhook:${id}`)})`;
    return reply.code(201).send({ id: `webhook:${id}` });
  });
  app.put(webhooksPath + "/:id", async (request) => {
    if (!cipher) throw new ApiError(409, "webhook_storage_unavailable", "Configure MINATO_AUDIT_SECRET to store Webhook URLs");
    const id = uuid.parse(z.object({ id: z.string() }).parse(request.params).id.replace(/^webhook:/, ""));
    const input = webhookInput.parse(request.body);
    const replacement = input.url ? parseUrl(input.url) : undefined;
    const [row] = await db`update notification_webhooks set name = ${input.name},
      hostname = coalesce(${replacement?.host ?? null}, hostname),
      sealed_url = coalesce(${replacement ? cipher.seal(replacement.href, `webhook:${id}`) : null}, sealed_url)
      where id = ${id} returning id`;
    if (!row) throw new ApiError(404, "webhook_not_found", "Webhook channel not found");
    return { id: `webhook:${id}` };
  });
  app.post(webhooksPath + "/:id/test", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!(await listWebhooks()).some((entry) => entry.id === id)) {
      throw new ApiError(404, "webhook_not_found", "Webhook channel not found");
    }
    const eventId = crypto.randomUUID();
    try {
      const target = await webhookTarget(db, env, id);
      const status = await postWebhook(target, eventId, {
        id: eventId, type: "model.catalog_changed", test: true,
        source: "minato-webhook-test", createdAt: new Date().toISOString(), scopes: [],
        counts: { added: 1 }, changes: [{ kind: "added", modelId: "example-model" }],
      });
      return reply.header("Cache-Control", "no-store").send({ ok: status >= 200 && status < 300, status });
    } catch {
      throw new ApiError(502, "webhook_delivery_failed", "Webhook delivery failed. Check the destination, DNS, and TLS.");
    }
  });
  app.get("/admin/v1/notifications", async (request) => {
    const { before } = z.object({ before: uuid.optional() }).parse(request.query);
    const rows = await db`select e.id, e.source_slug as source, e.payload, e.created_at as "createdAt",
      (select jsonb_agg(jsonb_build_object('channel', d.channel, 'state', d.state, 'scopes', d.scopes, 'lastError', d.last_error) order by d.channel)
        from model_event_deliveries d where d.event_id = e.id) as deliveries
      from model_events e where exists (select 1 from model_event_deliveries d where d.event_id = e.id)
      and (${before ?? null}::uuid is null or (e.created_at, e.id) <
        (select created_at, id from model_events where id = ${before ?? null}::uuid))
      order by e.created_at desc, e.id desc limit 21`;
    return { items: rows.slice(0, 20), before: rows.length > 20 ? rows[19].id : null };
  });
  app.post("/admin/v1/notifications/:event/retry", async (request, reply) => {
    const { event } = z.object({ event: uuid }).parse(request.params);
    const { channel } = z.strictObject({ channel: z.string().max(160) }).parse(request.body);
    const [row] = await db`update model_event_deliveries set state = 'pending', attempts = 0,
      next_attempt_at = now(), last_error = null where event_id = ${event} and channel = ${channel} and state = 'failed'
      returning event_id`;
    if (!row) throw new ApiError(409, "delivery_not_failed", "Only failed deliveries can be retried");
    return reply.code(202).send({ queued: true });
  });

  async function settings(scope: "global" | "project" | "environment", id?: string) {
    const webhooks = await listWebhooks();
    const available = ["in-app", ...webhooks.map((entry) => entry.id)];
    const channelNames = Object.fromEntries(webhooks.map((entry) => [entry.id, entry.name]));
    const [defaults] = await db`select channels from notification_defaults`;
    if (scope === "global") return { channels: defaults.channels, inherited: [], available, channelNames };
    const [row] = scope === "project"
      ? await db`select notification_channels as channels from projects where id = ${id!} and archived_at is null`
      : await db`select e.notification_channels as channels, p.notification_channels as inherited
        from environments e join projects p on p.id = e.project_id
        where e.id = ${id!} and e.archived_at is null and p.archived_at is null`;
    if (!row) throw new ApiError(404, "scope_not_found", "Notification scope not found");
    return { channels: row.channels, inherited: row.inherited ?? defaults.channels, available, channelNames };
  }
  app.get(settingsPath, async (request) => {
    const { scope, id } = scopeQuery.parse(request.query);
    return settings(scope, id);
  });
  app.put(settingsPath, async (request) => {
    const { scope, id } = scopeQuery.parse(request.query);
    const { channels } = z.strictObject({ channels: z.array(z.string()).max(50).nullable() }).parse(request.body);
    const available = ["in-app", ...(await listWebhooks()).map((entry) => entry.id)];
    if ((!channels && scope === "global") || channels?.some((channel) => !available.includes(channel))) {
      throw new ApiError(422, "invalid_channels", "Select available notification channels");
    }
    const values = channels ? JSON.stringify([...new Set(channels)]) : null;
    if (scope === "global") await db`update notification_defaults set channels = array(select jsonb_array_elements_text(${values}::text::jsonb))`;
    if (scope === "project") await db`update projects set notification_channels = case when ${values}::text::jsonb is null
      then null else array(select jsonb_array_elements_text(${values}::text::jsonb)) end where id = ${id!} and archived_at is null`;
    if (scope === "environment") await db`update environments set notification_channels = case when ${values}::text::jsonb is null
      then null else array(select jsonb_array_elements_text(${values}::text::jsonb)) end where id = ${id!} and archived_at is null`;
    return settings(scope, id);
  });
}
