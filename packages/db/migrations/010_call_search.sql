alter table calls add column correlation_id text;

create index calls_env_feature_cursor on calls (environment_id, feature_id, started_at desc, request_id desc);
create index calls_env_failures_cursor on calls (environment_id, started_at desc, request_id desc)
  where status in ('failed', 'interrupted', 'cancelled');
create index calls_env_correlation_cursor on calls (environment_id, correlation_id, started_at desc, request_id desc)
  where correlation_id is not null;
create index call_attempts_source_model_request on call_attempts (source_id, model_id, request_id);
create index call_attempts_model_request on call_attempts (model_id, request_id);
