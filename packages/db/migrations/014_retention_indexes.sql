create index calls_retention_idx on calls (started_at);
create index usage_retention_idx on attempt_usage (received_at);
