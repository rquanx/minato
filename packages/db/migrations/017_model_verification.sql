alter table source_models add column verification jsonb;
alter table call_attempts add column error_code text;
