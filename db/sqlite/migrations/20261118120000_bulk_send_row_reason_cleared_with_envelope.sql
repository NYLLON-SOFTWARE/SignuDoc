-- SQLite version of
-- db/migrations/20261118120000_bulk_send_row_reason_cleared_with_envelope.sql:
-- deleting an envelope clears the failure reason stored for its Send to many
-- row, as the foreign key clears the row's envelope_id.

drop trigger if exists envelopes_clear_bulk_send_row_reason;

create trigger envelopes_clear_bulk_send_row_reason
  before delete on envelopes
  for each row
begin
  update bulk_send_batch_rows
  set reason = null
  where envelope_id = old.id and reason is not null;
end;
