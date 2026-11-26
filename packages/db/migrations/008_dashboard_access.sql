create table dashboard_access (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  revision uuid not null default gen_random_uuid()
);

insert into dashboard_access default values;
