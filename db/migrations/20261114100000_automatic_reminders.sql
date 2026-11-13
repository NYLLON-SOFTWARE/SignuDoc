-- Automatic reminders, chosen by the sender for each envelope.
--
-- * envelopes.reminder_interval_days: how many days the daily job waits
--   after the last invitation or reminder before it reminds the signer whose
--   turn it is. Null means no automatic reminders.
-- * audit_events: a new kind for a reminder the job sent.

alter table public.envelopes
  add column if not exists reminder_interval_days smallint;

alter table public.envelopes
  drop constraint if exists envelopes_reminder_interval_days_check;

alter table public.envelopes
  add constraint envelopes_reminder_interval_days_check
    check (reminder_interval_days is null or reminder_interval_days between 1 and 30);

create index if not exists idx_envelopes_reminders_on
  on public.envelopes(id)
  where status = 'sent' and reminder_interval_days is not null;

alter table public.audit_events
  drop constraint if exists audit_events_event_check;

alter table public.audit_events
  add constraint audit_events_event_check
    check (event in (
      'created',
      'sent',
      'viewed',
      'consented',
      'verified',
      'verification_failed',
      'signed',
      'declined',
      'reminded_manual',
      'email_sent',
      'completed',
      'voided',
      'deadline_changed',
      'expired',
      'reminded_auto'
    ));
