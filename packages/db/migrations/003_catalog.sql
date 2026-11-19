create table sources (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  kind text not null check (kind in ('cpa','opencode-zen','opencode-go','openai')),
  directory_url text not null,
  api_base text not null,
  credential_env text not null,
  default_endpoint text not null,
  enabled boolean not null default true,
  revision integer not null default 1,
  sync_state text not null default 'pending',
  last_success_at timestamptz,
  next_sync_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  empty_count integer not null default 0
);

create table source_models (
  source_id uuid not null references sources(id),
  raw_model_id text not null,
  reported jsonb not null default '{}',
  capability_override jsonb,
  missing_count integer not null default 0,
  status text not null default 'listed' check (status in ('listed','removed')),
  last_seen_at timestamptz,
  primary key (source_id, raw_model_id)
);

create table source_syncs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id),
  status text not null,
  model_count integer,
  recorded_at timestamptz not null default now()
);

alter table environments add column default_pool jsonb not null default '[]';
alter table features add column routing_policy jsonb;
alter table features add column approved_policy jsonb;
alter table features add column reconcile_needed boolean not null default false;
alter table features add column unavailable boolean not null default false;
