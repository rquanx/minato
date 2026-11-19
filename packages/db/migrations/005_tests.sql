create table tests (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references environments(id),
  feature_id uuid not null references features(id),
  replay_of uuid references calls(request_id) on delete set null,
  idempotency_key text not null,
  fingerprint text not null,
  endpoint text not null,
  target jsonb not null,
  input_sealed text,
  output_sealed text,
  status text not null default 'queued',
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  unique (environment_id, idempotency_key)
);
create index tests_queue_idx on tests(status, created_at);
