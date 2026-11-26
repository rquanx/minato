alter table sources drop constraint sources_kind_check;
alter table sources add constraint sources_kind_check
  check (kind in ('cpa', 'opencode-zen', 'opencode-go', 'openai', 'anthropic'));
