-- sqlite: rebuilds tables
--
-- SQLite version of db/migrations/20261120090000_bulk_send_skipped_rows.sql:
-- a Send to many row can also be 'skipped'.
--
-- A CHECK constraint cannot be changed in place here, so
-- bulk_send_batch_rows is made again with the new one (see
-- db/sqlite/migrate.mjs). The trigger on envelopes that clears a row's
-- reason names the table, not this copy of it, and keeps working.

create table bulk_send_batch_rows_new (
  batch_id text not null references bulk_send_batches (id) on delete cascade,
  row_number integer not null,
  status text not null
    constraint bulk_send_batch_rows_status_check check (status in ('processing', 'sent', 'failed', 'skipped')),
  envelope_id text references envelopes (id) on delete set null,
  reason text,
  primary key (batch_id, row_number)
);

insert into bulk_send_batch_rows_new (batch_id, row_number, status, envelope_id, reason)
select batch_id, row_number, status, envelope_id, reason
from bulk_send_batch_rows;

drop table bulk_send_batch_rows;

alter table bulk_send_batch_rows_new rename to bulk_send_batch_rows;

create index idx_bulk_send_batch_rows_envelope_id
  on bulk_send_batch_rows (envelope_id)
  where envelope_id is not null;
