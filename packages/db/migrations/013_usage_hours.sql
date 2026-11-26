create table usage_hours (
  environment_id uuid not null references environments(id) on delete cascade,
  hour timestamptz not null,
  ready boolean not null default false,
  data jsonb not null default '[]',
  primary key (environment_id, hour)
);
create index usage_hours_pending on usage_hours (hour) where not ready;

create function invalidate_historical_usage() returns trigger language plpgsql as $$
begin
  update usage_hours h set ready = false
  from calls c join call_attempts a on a.request_id = c.request_id
  where a.id = new.attempt_id and h.environment_id = c.environment_id
    and h.hour = date_trunc('hour', c.started_at, 'UTC');
  return new;
end;
$$;
create trigger attempt_usage_invalidates_hour after insert or update on attempt_usage
  for each row execute function invalidate_historical_usage();
