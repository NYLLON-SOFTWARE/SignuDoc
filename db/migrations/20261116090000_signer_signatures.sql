-- Signatures in the signer's own name: advanced (AdES) and qualified (QES)
-- electronic signatures under eIDAS, made by a signing provider (eID Easy, or
-- a trust service provider with the Cloud Signature Consortium API).
--
-- * envelopes.signature_level: simple (SignuDoc's own signature, sealed by
--   the install), advanced or qualified. Chosen when the envelope is sent,
--   with the provider it was sent with.
-- * envelopes.revision_key / revision_sha256: the PDF as the last signer
--   signed it. Each signer adds a revision with their own signature on top,
--   so the signatures before stay valid.
-- * provider_signing_sessions: one signer's trip to the provider. What the
--   signer submitted, the signing link and the provider's working state are
--   kept encrypted (secret_data), and only until the signer is back.

alter table public.envelopes
  add column if not exists signature_level text not null default 'simple',
  add column if not exists signature_provider text,
  add column if not exists revision_key text,
  add column if not exists revision_sha256 text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'envelopes_signature_level_check'
  ) then
    alter table public.envelopes
      add constraint envelopes_signature_level_check
        check (
          signature_level in ('simple', 'advanced', 'qualified')
          and (signature_level = 'simple') = (signature_provider is null)
        );
  end if;
end
$$;

create table if not exists public.provider_signing_sessions (
  id text primary key,
  envelope_id text not null references public.envelopes (id) on delete cascade,
  signer_id text not null references public.signers (id) on delete cascade,
  provider text not null,
  level text not null check (level in ('advanced', 'qualified')),
  -- pending: at the provider; signing: back with a signature, being saved.
  state text not null default 'pending'
    check (state in ('pending', 'signing', 'completed', 'failed')),
  -- The revision this one is added to: null for the first signer.
  base_sha256 text,
  -- This signer's revision, prepared, then signed.
  revision_key text not null,
  -- SHA-256 (hex) of the bytes the signature covers.
  content_digest text not null,
  secret_data text not null,
  submitted_at bigint not null,
  created_at bigint not null,
  expires_at bigint not null,
  completed_at bigint
);

create index if not exists idx_provider_signing_sessions_signer
  on public.provider_signing_sessions (signer_id, state);

create index if not exists idx_provider_signing_sessions_envelope
  on public.provider_signing_sessions (envelope_id);
