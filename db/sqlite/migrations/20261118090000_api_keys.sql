-- SQLite version of db/migrations/20261118090000_api_keys.sql: API keys an
-- administrator makes for another app. See that file for what each column is.

create table if not exists api_keys (
  id text not null primary key,
  user_id text not null references "user" (id) on delete cascade,
  name text not null constraint api_keys_name_check check (length(name) between 1 and 80),
  prefix text not null,
  key_hash text not null unique constraint api_keys_key_hash_check check (length(key_hash) = 64),
  scope text not null constraint api_keys_scope_check check (scope in ('read', 'write')),
  created_at bigint not null,
  last_used_at bigint,
  expires_at bigint,
  revoked_at bigint
);

create index if not exists api_keys_user_id_idx on api_keys (user_id);
