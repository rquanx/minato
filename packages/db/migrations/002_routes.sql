create table route_versions (
  feature_id uuid not null references features(id),
  version bigint not null,
  candidates jsonb not null,
  requirements jsonb not null,
  state text not null default 'queued' check (state in ('queued','preparing','active','failed','superseded')),
  lease_until timestamptz,
  lease_token uuid,
  error_code text,
  created_at timestamptz not null default now(),
  primary key (feature_id, version)
);
create index route_queue_idx on route_versions(state, created_at) where state in ('queued','preparing');

alter table features add foreign key (id, active_version) references route_versions(feature_id, version);
alter table features add foreign key (id, desired_version) references route_versions(feature_id, version);
