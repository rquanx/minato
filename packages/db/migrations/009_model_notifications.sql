create table notification_defaults (
  singleton boolean primary key default true check (singleton),
  channels text[] not null default array['in-app']::text[]
);
insert into notification_defaults default values;

alter table projects add column notification_channels text[];
alter table environments add column notification_channels text[];

create table model_events (
  id uuid primary key default gen_random_uuid(),
  source_slug text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index model_events_recent on model_events (created_at desc, id desc);

create table model_event_deliveries (
  event_id uuid not null references model_events(id) on delete cascade,
  channel text not null,
  scopes jsonb not null,
  state text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  primary key (event_id, channel)
);
create index model_delivery_queue on model_event_deliveries (next_attempt_at)
  where state = 'pending';
