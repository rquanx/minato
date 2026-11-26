alter table tests add column runtime_retired_at timestamptz;
create index tests_runtime_retirement on tests (started_at)
  where runtime_retired_at is null and target->>'mode' = 'specific_model';
