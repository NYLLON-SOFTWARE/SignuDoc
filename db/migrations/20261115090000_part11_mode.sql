-- Part 11 mode: the controls FDA 21 CFR Part 11 asks of a system that keeps
-- signed electronic records. Off unless an administrator turns it on.
--
-- * app_settings.part11_mode: the switch.
-- * user: whether an administrator has checked who the person is (11.100(b)),
--   and the lock that wrong passwords at signing put on the account (11.300).
-- * envelopes.part11: the envelope was sent while the mode was on, so its
--   signers sign with their accounts. Kept with the envelope, so turning the
--   mode off later does not change the rules an envelope went out under.
-- * signers: the account that must sign, and what the signature means
--   (11.50: approval, review, responsibility or authorship).
-- * audit_events: a new event kind for a wrong password at signing.
-- * system_audit_events: one hash chain for the changes that are not about a
--   single envelope (settings, roles, identity checks, locks), 11.10(e).

alter table public.app_settings
  add column if not exists part11_mode boolean not null default false;

alter table public."user"
  add column if not exists identity_verified_at bigint,
  add column if not exists identity_verified_by text,
  add column if not exists identity_verification_note text,
  add column if not exists signing_failed_attempts integer not null default 0,
  add column if not exists signing_locked_at bigint;

alter table public.envelopes
  add column if not exists part11 boolean not null default false;

alter table public.signers
  add column if not exists user_id text,
  add column if not exists signature_meaning text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'signers_signature_meaning_check'
  ) then
    alter table public.signers
      add constraint signers_signature_meaning_check
        check (
          signature_meaning is null
          or signature_meaning in ('approval', 'review', 'responsibility', 'authorship')
        );
  end if;
end
$$;

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
      'reminded_auto',
      'reauthentication_failed'
    ));

create table if not exists public.system_audit_events (
  id text primary key,
  sequence integer not null unique,
  event text not null,
  actor_user_id text,
  actor_email text,
  target_user_id text,
  ip_address text,
  user_agent text,
  metadata jsonb,
  created_at bigint not null,
  prev_hash text,
  row_hash text not null
);

create index if not exists idx_system_audit_events_created_at
  on public.system_audit_events (created_at desc);
