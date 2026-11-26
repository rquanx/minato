create table notification_webhooks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  hostname text not null,
  sealed_url text not null,
  created_at timestamptz not null default now()
);
