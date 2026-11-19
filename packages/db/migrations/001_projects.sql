create table projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  slug text not null,
  display_name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, slug)
);

create table admin_sessions (
  digest text primary key,
  expires_at timestamptz not null
);

create table environment_keys (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references environments(id),
  public_key_id text not null unique,
  digest text not null,
  label text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index environment_keys_environment_idx on environment_keys (environment_id, created_at desc, id);

create table features (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references environments(id),
  slug text not null,
  alias text not null unique,
  declaration jsonb not null,
  registration_revision integer not null default 1,
  draft jsonb,
  draft_revision integer not null default 0,
  active_version bigint,
  desired_version bigint,
  created_at timestamptz not null default now(),
  unique (environment_id, slug)
);

create table admin_events (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  action text not null,
  entity_id uuid not null,
  created_at timestamptz not null default now()
);
