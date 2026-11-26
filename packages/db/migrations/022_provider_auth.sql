alter table source_credentials add column auth_type text not null default 'api_key'
  check (auth_type in ('api_key', 'oauth', 'service_account'));
alter table source_credentials add column expires_at timestamptz;
alter table source_credentials add column refresh_at timestamptz;
alter table source_credentials add column refresh_error text;
alter table source_credentials add column token_version integer not null default 0;
create index source_credentials_refresh on source_credentials(refresh_at) where refresh_at is not null;

create table provider_oauth_sessions (
  state_hash text primary key,
  source_id uuid not null references sources(id),
  source_revision integer not null,
  session_ref text not null references admin_sessions(digest) on delete cascade,
  verifier_sealed text not null,
  redirect_uri text not null,
  expires_at timestamptz not null default now() + interval '10 minutes',
  status text not null default 'pending'
);
create index provider_oauth_sessions_expiry on provider_oauth_sessions(expires_at);
create table provider_device_sessions (
  id uuid primary key,
  source_id uuid not null references sources(id),
  source_revision integer not null,
  session_ref text not null references admin_sessions(digest) on delete cascade,
  sealed text not null,
  poll_after timestamptz not null,
  expires_at timestamptz not null default now() + interval '15 minutes'
);

alter table sources drop constraint sources_kind_check;
alter table sources add constraint sources_kind_check
  check (kind in ('cpa', 'opencode-zen', 'opencode-go', 'openai', 'anthropic', 'gemini', 'vertex', 'codex'));
