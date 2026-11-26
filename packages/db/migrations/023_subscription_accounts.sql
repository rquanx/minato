create table subscription_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_source_id uuid not null references sources(id),
  credential_id uuid not null unique references source_credentials(id)
);
alter table sources drop constraint sources_id_credential_id_fkey;
alter table sources add foreign key (credential_id) references source_credentials(id);
alter table sources add column account_id uuid references subscription_accounts(id);
create index sources_account_idx on sources(account_id);
create table source_credential_grants (
  source_id uuid not null references sources(id),
  credential_id uuid not null references source_credentials(id) on delete cascade,
  primary key (source_id, credential_id)
);
insert into subscription_accounts (owner_source_id, credential_id)
select id, credential_id from sources where credential_id is not null;
update sources s set account_id = a.id from subscription_accounts a where a.owner_source_id = s.id;
