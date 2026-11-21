-- Approvers.
--
-- * signers.role 'approver': someone in the signing order who reviews the
--   document and approves or rejects it. An approver has no fields, places
--   no signature, and is not stamped into the signed PDF. They take part in
--   the steps of the signing order like a signer: the next step starts once
--   every signer and approver of the step before is done.
--
--   An approval is stored as the row's turn being done, status 'signed',
--   with signed_at the time of the approval, so that every query that moves
--   the order on, counts who is still to act or locks a turn treats an
--   approver exactly as a signer. A rejection is stored as 'declined', the
--   same as a decline, and ends the envelope. What people are shown, the
--   audit trail and the certificate tell the two apart by role and by the
--   events below.
--
-- * audit_events: 'approved' and 'rejected' for an approver's decision.
--
-- A copy of the app from before this migration still runs on this database
-- as long as no approver has been added: it reads signers by role 'signer'
-- and would leave an approver out of the signing order. Roll back past this
-- migration only with no approvers on envelopes out for signature.

alter table public.signers
  drop constraint if exists signers_role_check;

alter table public.signers
  add constraint signers_role_check
    check (role in ('signer', 'approver', 'cc'));

alter table public.signers
  drop constraint if exists signers_copy_recipient_has_no_step;

alter table public.signers
  add constraint signers_copy_recipient_has_no_step
    check (role in ('signer', 'approver') or signing_step is null);

alter table public.signers
  drop constraint if exists signers_copy_recipient_never_signs;

alter table public.signers
  add constraint signers_copy_recipient_never_signs
    check (
      role in ('signer', 'approver')
      or (status = 'pending' and signing_token_hash is null)
    );

-- An approver places no fields. Checked when fields are saved and when the
-- envelope is sent; this keeps a row written by hand from slipping through.
create or replace function public.signudoc_fields_not_for_approvers()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.signers s
    where s.id = new.signer_id
      and s.envelope_id = new.envelope_id
      and s.role = 'approver'
  ) then
    raise exception 'An approver has no fields.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists fields_not_for_approvers on public.fields;

create trigger fields_not_for_approvers
  before insert or update of signer_id on public.fields
  for each row execute function public.signudoc_fields_not_for_approvers();

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
      'reauthentication_failed',
      'copied',
      'signer_corrected',
      'approved',
      'rejected'
    ));
