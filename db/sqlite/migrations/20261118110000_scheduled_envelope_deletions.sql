-- SQLite version of db/migrations/20261118110000_scheduled_envelope_deletions.sql:
-- finished envelopes an administrator has asked to delete, kept for the
-- waiting period. See that file for what each column is.

create table if not exists scheduled_envelope_deletions (
  envelope_id text not null primary key
    references envelopes (id) on delete cascade,
  requested_by_user_id text not null,
  requested_by_email text not null,
  requested_at bigint not null,
  delete_after bigint not null,
  reason text,
  sender_notified_at bigint,
  cancelled_at bigint,
  cancelled_by_user_id text,
  cancelled_by_email text,
  cancel_notified_at bigint,
  last_attempt_at bigint
);

create index if not exists scheduled_envelope_deletions_due_idx
  on scheduled_envelope_deletions (delete_after);
