create table members (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);
alter table admin_sessions add column member_id uuid references members(id);
alter table tests add column actor uuid references members(id);
create table environment_memberships (
  environment_id uuid not null references environments(id),
  member_id uuid not null references members(id) on delete cascade,
  can_usage boolean not null default false,
  can_content boolean not null default false,
  can_test boolean not null default false,
  primary key(environment_id, member_id),
  check (not can_content or can_usage)
);
