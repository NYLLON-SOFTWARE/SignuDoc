-- SQLite version of db/migrations/20261118090000_bulk_send_batches.sql: a
-- confirmed Send to many batch and the result of each of its rows. See that
-- file for what each column is.

create table if not exists bulk_send_batches (
  id text not null primary key,
  user_id text not null references "user" (id) on delete cascade,
  template_id text not null references templates (id) on delete cascade,
  batch_key text not null,
  request_fingerprint text not null,
  claim_token text,
  claimed_at bigint,
  created_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  constraint bulk_send_batches_user_key unique (user_id, batch_key)
);

create table if not exists bulk_send_batch_rows (
  batch_id text not null references bulk_send_batches (id) on delete cascade,
  row_number integer not null,
  status text not null
    constraint bulk_send_batch_rows_status_check check (status in ('processing', 'sent', 'failed')),
  envelope_id text references envelopes (id) on delete set null,
  reason text,
  primary key (batch_id, row_number)
);

create index if not exists idx_bulk_send_batch_rows_envelope_id
  on bulk_send_batch_rows (envelope_id)
  where envelope_id is not null;
