-- SQLite version of db/migrations/20261118100000_api_envelopes.sql: which
-- key made an envelope, the app's own metadata and signer references, and
-- the stored answers that make a retried request safe. See that file for
-- what each column is.

alter table envelopes add column api_key_id text;
alter table envelopes add column api_metadata jsonb;

alter table signers add column api_ref text;

create table if not exists api_idempotency (
  api_key_id text not null,
  idempotency_key text not null
    constraint api_idempotency_idempotency_key_check check (length(idempotency_key) between 1 and 255),
  request_hash text not null constraint api_idempotency_request_hash_check check (length(request_hash) = 64),
  status_code integer,
  response jsonb,
  created_at bigint not null,
  primary key (api_key_id, idempotency_key)
);

create index if not exists api_idempotency_created_at_idx
  on api_idempotency (created_at);
