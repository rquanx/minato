alter table sources alter column credential_env drop not null;
alter table sources drop constraint sources_kind_check;
alter table sources add constraint sources_kind_check
  check (kind in ('cpa', 'opencode-zen', 'opencode-go', 'openai', 'anthropic', 'gemini'));

create table source_credentials (
  id uuid primary key,
  source_id uuid not null references sources(id),
  sealed_key text not null,
  origins text[] not null,
  imported_at timestamptz not null default now(),
  unique (source_id, id)
);
alter table sources add column credential_id uuid;
alter table sources add foreign key (id, credential_id) references source_credentials(source_id, id);
