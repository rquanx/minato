alter table environments add column audit_enabled boolean not null default false;
alter table environments add column audit_days integer not null default 7;
alter table environments add column audit_limit integer not null default 262144;
alter table environments add column audit_redact jsonb not null default '[]';
alter table environments add column settings_revision integer not null default 0;

create table calls (
  request_id uuid primary key,
  environment_id uuid not null references environments(id),
  feature_id uuid not null references features(id),
  route_version bigint not null,
  kind text not null default 'production',
  status text not null default 'started',
  endpoint text not null,
  capture_state text not null,
  http_status integer,
  duration_ms integer,
  started_at timestamptz not null default now()
);
create index calls_env_recent_idx on calls(environment_id, started_at desc, request_id desc);
create index calls_feature_recent_idx on calls(feature_id, started_at desc);

create table call_attempts (
  id uuid primary key,
  request_id uuid not null references calls(request_id) on delete cascade,
  source_id text not null,
  model_id text not null,
  http_status integer,
  duration_ms integer,
  retryable boolean,
  captured_at timestamptz not null default now()
);
create index call_attempts_request_idx on call_attempts(request_id);

create table attempt_usage (
  attempt_id uuid primary key,
  input_tokens bigint,
  output_tokens bigint,
  total_tokens bigint,
  cached_tokens bigint,
  reasoning_tokens bigint,
  received_at timestamptz not null default now()
);

create table call_content (
  request_id uuid not null references calls(request_id) on delete cascade,
  kind text not null check(kind in ('request','response')),
  sealed text not null,
  capture_state text not null,
  expires_at timestamptz not null,
  primary key(request_id, kind)
);
create index call_content_expiry_idx on call_content(expires_at);
