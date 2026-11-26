import type { connectDatabase } from "./client";

type Query = Pick<ReturnType<typeof connectDatabase>, "unsafe">;
export type ModelChange = { kind: string; modelId: string };

export async function recordModelEvent(tx: Query, source: { id: string; slug: string }, changes: ModelChange[], status?: string) {
  const counts: Record<string, number> = {};
  for (const change of changes) counts[change.kind] = (counts[change.kind] ?? 0) + 1;
  const payload = JSON.stringify({ status, counts, changes: changes.slice(0, 100) });
  await tx.unsafe(`with event as (
    insert into model_events (source_slug, payload) values ($2, $3::text::jsonb) returning id
  ), affected as (
    select distinct p.slug as project, e.slug as environment,
      coalesce(e.notification_channels, p.notification_channels, settings.channels) as channels
    from environments e join projects p on p.id = e.project_id cross join notification_defaults settings
    where p.archived_at is null and e.archived_at is null and exists (
      select 1 from features f left join route_versions r on (r.feature_id, r.version) = (f.id, f.active_version)
      where f.environment_id = e.id and exists (
        select 1 from jsonb_array_elements(
          coalesce(r.candidates, '[]') ||
          case when f.approved_policy is null then '[]'::text::jsonb else
            jsonb_build_array(coalesce(f.approved_policy->'primary', f.declaration->'preferredModel')) ||
            coalesce(f.approved_policy->'fallbacks', '[]') ||
            coalesce(f.approved_policy->'orderedModels', '[]') || e.default_pool end
        ) as reference
        where reference->>'sourceId' in ($1, $2)
      )
    )
  ), recipients as (
    select unnest(channels) as channel, jsonb_build_object('project', project, 'environment', environment) as scope from affected
    union all
    select unnest(channels), null from notification_defaults where not exists (select 1 from affected)
  )
  insert into model_event_deliveries (event_id, channel, scopes, state)
  select event.id, channel, coalesce(jsonb_agg(scope order by scope) filter (where scope is not null), '[]'),
    case when channel = 'in-app' then 'delivered' else 'pending' end
  from event cross join recipients group by event.id, channel`, [source.id, source.slug, payload]);
}

export function notificationChannels(env: NodeJS.ProcessEnv) {
  return Object.keys(env).filter((name) => /^MINATO_NOTIFY_WEBHOOK_[A-Z][A-Z0-9_]*$/.test(name) && env[name]).sort();
}

export async function recordRouteEvent(tx: Query, featureId: string, status: string, version?: string) {
  await tx.unsafe(`with scope as (
    select f.alias, e.slug as environment, p.slug as project,
      coalesce(e.notification_channels,p.notification_channels,n.channels) as channels
    from features f join environments e on e.id = f.environment_id
    join projects p on p.id = e.project_id cross join notification_defaults n where f.id = $1
  ), event as (
    insert into model_events (source_slug,payload)
    select alias,jsonb_build_object('type','model.route_changed','status',$2::text,'version',$3::text,
      'counts','{}'::jsonb,'changes','[]'::jsonb) from scope returning id
  )
  insert into model_event_deliveries(event_id,channel,scopes,state)
  select event.id, channel, jsonb_build_array(jsonb_build_object('project',project,'environment',environment)),
    case when channel = 'in-app' then 'delivered' else 'pending' end
  from event cross join scope cross join lateral unnest(channels) channel`, [featureId,status,version ?? null]);
}
