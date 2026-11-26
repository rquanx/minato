alter table environments add column auto_publish_routes boolean not null default false;
alter table features add column route_reason text;
alter table route_versions add column origin text not null default 'manual';
alter table route_versions add column runtime_retired_at timestamptz;
alter table route_versions add column finished_at timestamptz;
alter table call_attempts add column price_snapshot jsonb;
alter table model_event_deliveries add column last_error text;
