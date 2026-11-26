alter table sources add column directory_enabled boolean not null default true;
alter table source_models add column manual boolean not null default false;
alter table source_syncs add column error_code text;
alter table source_syncs add column http_status integer;
create index source_syncs_latest_idx on source_syncs(source_id, recorded_at desc, id desc);
alter table source_credentials add column superseded_at timestamptz;
create index source_credentials_superseded_idx on source_credentials(superseded_at) where superseded_at is not null;
update source_credentials c set superseded_at = now()
where not exists (select 1 from sources s where s.credential_id = c.id);
