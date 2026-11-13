-- A deadline for each envelope, chosen by the sender when it is sent.
--
-- * envelopes.expires_at: when the request stops being signable. Every
--   signing link of the envelope expires at this moment. Null on envelopes
--   sent before this migration, whose links keep their own seven-day life.
-- * envelopes.expiry_notified_at: set once the daily job has told the sender
--   that the deadline passed, so it tells them only once.
-- * audit_events: two new kinds, for a changed deadline and a passed one.

alter table public.envelopes
  add column if not exists expires_at bigint,
  add column if not exists expiry_notified_at bigint;

create index if not exists idx_envelopes_expiry_due
  on public.envelopes(expires_at)
  where status = 'sent'
    and expires_at is not null
    and expiry_notified_at is null;

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
      'expired'
    ));
