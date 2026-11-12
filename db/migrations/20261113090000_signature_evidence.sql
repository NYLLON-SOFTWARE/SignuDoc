-- Evidence and record-keeping for signed documents.
--
-- * envelopes: the SHA-256 of each finished file, so a copy can be checked
--   against the original later, and when the owner was last warned that the
--   retention period is about to remove the envelope.
-- * seal_keys: the key this install seals finished PDFs with. The private
--   key is stored encrypted with a key derived from the auth secret.
-- * signers: optional extra checks before signing (an access code the sender
--   shares, a one-time code sent by email), and when the signer agreed to
--   use electronic records.
-- * audit_events: new event kinds, and a hash chain so that a changed or
--   removed row can be detected.
-- * app_settings: how long finished envelopes are kept.

alter table public.envelopes
  add column if not exists signed_pdf_sha256 text
    check (signed_pdf_sha256 is null or length(signed_pdf_sha256) = 64),
  add column if not exists evidence_sha256 text
    check (evidence_sha256 is null or length(evidence_sha256) = 64),
  add column if not exists recipient_evidence_sha256 text
    check (
      recipient_evidence_sha256 is null
      or length(recipient_evidence_sha256) = 64
    ),
  add column if not exists retention_warned_at bigint;

create index if not exists idx_envelopes_signed_pdf_sha256
  on public.envelopes(signed_pdf_sha256)
  where signed_pdf_sha256 is not null;

create index if not exists idx_envelopes_evidence_sha256
  on public.envelopes(evidence_sha256)
  where evidence_sha256 is not null;

create index if not exists idx_envelopes_recipient_evidence_sha256
  on public.envelopes(recipient_evidence_sha256)
  where recipient_evidence_sha256 is not null;

create table if not exists public.seal_keys (
  id text primary key,
  certificate_pem text not null,
  encrypted_private_key text not null,
  created_at bigint not null,
  retired_at bigint
);

create unique index if not exists idx_seal_keys_single_active
  on public.seal_keys ((true))
  where retired_at is null;

alter table public.signers
  add column if not exists access_code_hash text,
  add column if not exists require_email_code boolean not null default false,
  add column if not exists email_code_hash text,
  add column if not exists email_code_expires_at bigint,
  add column if not exists email_code_attempts integer not null default 0,
  add column if not exists email_code_sent_at bigint,
  add column if not exists consented_at bigint;

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
      'voided'
    ));

alter table public.audit_events
  add column if not exists sequence integer,
  add column if not exists prev_hash text,
  add column if not exists row_hash text;

create unique index if not exists idx_audit_events_envelope_sequence
  on public.audit_events(envelope_id, sequence)
  where sequence is not null;

alter table public.app_settings
  add column if not exists retention_days integer
    check (retention_days is null or retention_days >= 30);
