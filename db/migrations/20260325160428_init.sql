create table if not exists public."user" (
  id text primary key,
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default false,
  image text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);

create table if not exists public.session (
  id text primary key,
  "expiresAt" timestamptz not null,
  token text not null unique,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references public."user"(id) on delete cascade
);

create table if not exists public.account (
  id text primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references public."user"(id) on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);

create table if not exists public.verification (
  id text primary key,
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);

create table if not exists public.envelopes (
  id text primary key,
  user_id text not null references public."user"(id) on delete cascade,
  title text not null,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'completed', 'declined', 'voided')),
  source_pdf_key text not null,
  source_pdf_filename text not null,
  source_pdf_size_bytes bigint not null check (source_pdf_size_bytes > 0),
  page_count integer not null check (page_count > 0),
  signed_pdf_key text,
  evidence_key text,
  source_pdf_hash text not null check (length(source_pdf_hash) = 64),
  sent_at bigint,
  completed_at bigint,
  declined_at bigint,
  voided_at bigint,
  created_at bigint not null default (extract(epoch from now())::bigint),
  updated_at bigint not null default (extract(epoch from now())::bigint)
);

create table if not exists public.envelope_pages (
  id text primary key,
  envelope_id text not null references public.envelopes(id) on delete cascade,
  page_number integer not null check (page_number > 0),
  width_pt real not null check (width_pt > 0),
  height_pt real not null check (height_pt > 0),
  unique (envelope_id, page_number)
);

create table if not exists public.signers (
  id text primary key,
  envelope_id text not null references public.envelopes(id) on delete cascade,
  name text not null,
  email text not null,
  sign_order integer not null check (sign_order > 0),
  status text not null default 'pending'
    check (status in ('pending', 'notified', 'signed', 'declined')),
  signing_token_hash text,
  signing_token_expires_at bigint,
  turn_started_at bigint,
  last_notified_at bigint,
  last_nudged_at bigint,
  signed_at bigint,
  declined_at bigint,
  decline_reason text,
  created_at bigint not null default (extract(epoch from now())::bigint),
  updated_at bigint not null default (extract(epoch from now())::bigint),
  constraint signers_id_envelope_unique unique (id, envelope_id),
  constraint signers_envelope_order_unique unique (envelope_id, sign_order)
);

create table if not exists public.recipient_download_tokens (
  token_hash text primary key check (length(token_hash) = 64),
  envelope_id text not null,
  signer_id text not null,
  file_type text not null check (file_type in ('signed', 'evidence')),
  expires_at bigint not null,
  created_at bigint not null default (extract(epoch from now())::bigint),
  constraint recipient_download_tokens_signer_envelope_fk
    foreign key (signer_id, envelope_id)
    references public.signers(id, envelope_id)
    on delete cascade,
  constraint recipient_download_tokens_signer_file_unique
    unique (envelope_id, signer_id, file_type),
  check (expires_at >= created_at)
);

create table if not exists public.fields (
  id text primary key,
  envelope_id text not null references public.envelopes(id) on delete cascade,
  signer_id text not null,
  type text not null
    check (type in ('signature', 'initials', 'date', 'text', 'checkbox')),
  page integer not null check (page > 0),
  x real not null check (x >= 0 and x <= 1),
  y real not null check (y >= 0 and y <= 1),
  width real not null check (width > 0 and width <= 1),
  height real not null check (height > 0 and height <= 1),
  required boolean not null default true,
  label text,
  input_method text
    check (input_method is null or input_method in ('typed', 'drawn', 'auto')),
  value text,
  image_key text,
  checked boolean,
  submitted_at bigint,
  created_at bigint not null default (extract(epoch from now())::bigint),
  updated_at bigint not null default (extract(epoch from now())::bigint),
  check (x + width <= 1.000001),
  check (y + height <= 1.000001),
  constraint fields_signer_envelope_fk
    foreign key (signer_id, envelope_id)
    references public.signers(id, envelope_id)
    on delete cascade
);

create table if not exists public.audit_events (
  id text primary key,
  envelope_id text not null references public.envelopes(id) on delete cascade,
  event text not null
    check (event in (
      'created',
      'sent',
      'viewed',
      'signed',
      'declined',
      'reminded_manual',
      'completed',
      'voided'
    )),
  actor_type text not null
    check (actor_type in ('sender', 'signer', 'system')),
  actor_email text,
  ip_address text,
  user_agent text,
  metadata jsonb,
  created_at bigint not null default (extract(epoch from now())::bigint)
);

create table if not exists public.account_closure_requests (
  user_id text primary key references public."user"(id) on delete cascade,
  requested_at bigint not null,
  export_expires_at bigint not null,
  purge_after_at bigint not null,
  updated_at bigint not null,
  check (export_expires_at >= requested_at),
  check (purge_after_at >= export_expires_at)
);

create index if not exists account_userid_idx
  on public.account ("userId");

create index if not exists session_userid_idx
  on public.session ("userId");

create index if not exists verification_identifier_idx
  on public.verification (identifier);

create index if not exists idx_envelopes_user_created_at
  on public.envelopes(user_id, created_at desc);

create index if not exists idx_envelopes_user_status
  on public.envelopes(user_id, status, created_at desc);

create unique index if not exists idx_signers_envelope_email
  on public.signers(envelope_id, lower(email));

create index if not exists idx_signers_envelope_status
  on public.signers(envelope_id, status);

create unique index if not exists idx_signers_signing_token_hash
  on public.signers(signing_token_hash)
  where signing_token_hash is not null;

create unique index if not exists idx_signers_single_notified
  on public.signers(envelope_id)
  where status = 'notified';

create index if not exists idx_recipient_download_tokens_expires_at
  on public.recipient_download_tokens(expires_at);

create index if not exists idx_fields_signer_envelope
  on public.fields(signer_id, envelope_id);

create index if not exists idx_fields_envelope_page
  on public.fields(envelope_id, page, created_at, id);

create index if not exists idx_audit_events_envelope_event
  on public.audit_events(envelope_id, event);

create index if not exists idx_audit_events_envelope_created_at
  on public.audit_events(envelope_id, created_at, id);

create index if not exists idx_audit_events_envelope_event_signer_id
  on public.audit_events(envelope_id, event, ((metadata->>'signerId')));

create index if not exists idx_account_closure_requests_purge_after
  on public.account_closure_requests(purge_after_at, requested_at);
