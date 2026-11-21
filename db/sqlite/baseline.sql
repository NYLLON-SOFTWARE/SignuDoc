-- The SQLite schema: everything the Postgres migrations listed in
-- baseline.versions produce, in one file. See docs/design/database-backends.md.
--
-- Declared types matter: the app reads columns back by them (TIMESTAMPTZ as
-- a Date, BOOLEAN as true/false, JSONB and TEXT[] as parsed JSON, BIGINT and
-- INTEGER as numbers, BYTEA as a Buffer), exactly as pg returns the
-- Postgres types of the same name.
--
-- Only SQLite's own functions are used here (no functions the app
-- registers), so any SQLite client can write to this file.
--
-- Timestamps of type TIMESTAMPTZ are stored as text in one fixed format,
-- YYYY-MM-DDTHH:MM:SS.sssZ, so that comparing them as text compares them
-- as times. Epoch-second columns are BIGINT, as in Postgres.

create table "user" (
  id text not null primary key,
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default 0,
  image text,
  "createdAt" timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  role text not null default 'user' constraint user_role_check check (role in ('user', 'admin')),
  identity_verified_at bigint,
  identity_verified_by text,
  identity_verification_note text,
  signing_failed_attempts integer not null default 0,
  signing_locked_at bigint,
  "twoFactorEnabled" boolean not null default 0
);

create index user_role_admin_idx on "user" (role) where role = 'admin';

create table session (
  id text not null primary key,
  "expiresAt" timestamptz not null,
  token text not null unique,
  "createdAt" timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" (id) on delete cascade,
  last_active_at bigint
);

create index session_userid_idx on session ("userId");

create table account (
  id text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" (id) on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index account_userid_idx on account ("userId");

create table verification (
  id text not null primary key,
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index verification_identifier_idx on verification (identifier);

create table "twoFactor" (
  id text not null primary key,
  secret text not null,
  "backupCodes" text not null,
  "userId" text not null references "user" (id) on delete cascade,
  verified boolean not null default 1,
  "failedVerificationCount" integer not null default 0,
  "lockedUntil" timestamptz
);

create index "twoFactor_secret_idx" on "twoFactor" (secret);
create index "twoFactor_userId_idx" on "twoFactor" ("userId");

create table envelopes (
  id text not null primary key,
  user_id text not null references "user" (id) on delete cascade,
  title text not null,
  status text not null default 'draft'
    constraint envelopes_status_check check (status in ('draft', 'sent', 'completed', 'declined', 'voided')),
  source_pdf_key text not null,
  source_pdf_filename text not null,
  source_pdf_size_bytes bigint not null constraint envelopes_source_pdf_size_bytes_check check (source_pdf_size_bytes > 0),
  page_count integer not null constraint envelopes_page_count_check check (page_count > 0),
  signed_pdf_key text,
  evidence_key text,
  source_pdf_hash text not null constraint envelopes_source_pdf_hash_check check (length(source_pdf_hash) = 64),
  sent_at bigint,
  completed_at bigint,
  declined_at bigint,
  voided_at bigint,
  created_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  updated_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  signed_pdf_sha256 text
    constraint envelopes_signed_pdf_sha256_check check (signed_pdf_sha256 is null or length(signed_pdf_sha256) = 64),
  evidence_sha256 text
    constraint envelopes_evidence_sha256_check check (evidence_sha256 is null or length(evidence_sha256) = 64),
  recipient_evidence_sha256 text constraint envelopes_recipient_evidence_sha256_check check (
    recipient_evidence_sha256 is null or length(recipient_evidence_sha256) = 64
  ),
  retention_warned_at bigint,
  expires_at bigint,
  expiry_notified_at bigint,
  reminder_interval_days smallint constraint envelopes_reminder_interval_days_check check (
    reminder_interval_days is null
    or (reminder_interval_days >= 1 and reminder_interval_days <= 30)
  ),
  handed_over_at bigint,
  part11 boolean not null default 0,
  signature_level text not null default 'simple',
  signature_provider text,
  revision_key text,
  revision_sha256 text,
  constraint envelopes_signature_level_check check (
    signature_level in ('simple', 'advanced', 'qualified')
    and (signature_level = 'simple') = (signature_provider is null)
  )
);

create index idx_envelopes_user_created_at on envelopes (user_id, created_at desc);
create index idx_envelopes_user_status on envelopes (user_id, status, created_at desc);
create index idx_envelopes_evidence_sha256 on envelopes (evidence_sha256)
  where evidence_sha256 is not null;
create index idx_envelopes_recipient_evidence_sha256
  on envelopes (recipient_evidence_sha256)
  where recipient_evidence_sha256 is not null;
create index idx_envelopes_signed_pdf_sha256 on envelopes (signed_pdf_sha256)
  where signed_pdf_sha256 is not null;
create index idx_envelopes_expiry_due on envelopes (expires_at)
  where status = 'sent' and expires_at is not null and expiry_notified_at is null;
create index idx_envelopes_reminders_on on envelopes (id)
  where status = 'sent' and reminder_interval_days is not null;

create table envelope_pages (
  id text not null primary key,
  envelope_id text not null references envelopes (id) on delete cascade,
  page_number integer not null constraint envelope_pages_page_number_check check (page_number > 0),
  width_pt real not null constraint envelope_pages_width_pt_check check (width_pt > 0),
  height_pt real not null constraint envelope_pages_height_pt_check check (height_pt > 0),
  constraint envelope_pages_envelope_id_page_number_key
    unique (envelope_id, page_number)
);

create table signers (
  id text not null primary key,
  envelope_id text not null references envelopes (id) on delete cascade,
  name text not null,
  email text not null,
  sign_order integer not null constraint signers_sign_order_check check (sign_order > 0),
  status text not null default 'pending'
    constraint signers_status_check check (status in ('pending', 'notified', 'signed', 'declined')),
  signing_token_hash text,
  signing_token_expires_at bigint,
  turn_started_at bigint,
  last_notified_at bigint,
  last_nudged_at bigint,
  signed_at bigint,
  declined_at bigint,
  decline_reason text,
  created_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  updated_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  access_code_hash text,
  require_email_code boolean not null default 0,
  email_code_hash text,
  email_code_expires_at bigint,
  email_code_attempts integer not null default 0,
  email_code_sent_at bigint,
  consented_at bigint,
  role text not null default 'signer',
  user_id text,
  signature_meaning text constraint signers_signature_meaning_check check (
    signature_meaning is null
    or signature_meaning in ('approval', 'review', 'responsibility', 'authorship')
  ),
  constraint signers_role_check check (role in ('signer', 'cc')),
  constraint signers_copy_recipient_never_signs check (
    role = 'signer'
    or (status = 'pending' and signing_token_hash is null)
  ),
  constraint signers_id_envelope_unique unique (id, envelope_id),
  constraint signers_envelope_order_unique unique (envelope_id, sign_order)
);

-- Postgres keys this on lower(email). Here it is COLLATE NOCASE, which
-- needs no function: the app's connections define a lower() that folds
-- every letter (db/sqlite/open.mjs), another SQLite client has the built-in
-- one, which folds ASCII only, and an index on lower() would then differ
-- between the two.
create unique index idx_signers_envelope_email on signers (envelope_id, email collate nocase);
create index idx_signers_envelope_status on signers (envelope_id, status);
create unique index idx_signers_signing_token_hash on signers (signing_token_hash)
  where signing_token_hash is not null;
create unique index idx_signers_single_notified on signers (envelope_id)
  where status = 'notified';

create table recipient_download_tokens (
  token_hash text not null primary key constraint recipient_download_tokens_token_hash_check check (length(token_hash) = 64),
  envelope_id text not null,
  signer_id text not null,
  file_type text not null constraint recipient_download_tokens_file_type_check check (file_type in ('signed', 'evidence')),
  expires_at bigint not null,
  created_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  constraint recipient_download_tokens_signer_envelope_fk
    foreign key (signer_id, envelope_id)
    references signers (id, envelope_id)
    on delete cascade,
  constraint recipient_download_tokens_signer_file_unique
    unique (envelope_id, signer_id, file_type),
  constraint recipient_download_tokens_check check (expires_at >= created_at)
);

create index idx_recipient_download_tokens_expires_at
  on recipient_download_tokens (expires_at);

create table fields (
  id text not null primary key,
  envelope_id text not null references envelopes (id) on delete cascade,
  signer_id text not null,
  type text not null constraint fields_type_check check (
    type in (
      'signature',
      'initials',
      'date',
      'name',
      'text',
      'checkbox',
      'number',
      'dropdown',
      'radio'
    )
  ),
  page integer not null constraint fields_page_check check (page > 0),
  x real not null constraint fields_x_check check (x >= 0 and x <= 1),
  y real not null constraint fields_y_check check (y >= 0 and y <= 1),
  width real not null constraint fields_width_check check (width > 0 and width <= 1),
  height real not null constraint fields_height_check check (height > 0 and height <= 1),
  required boolean not null default 1,
  label text,
  input_method text
    constraint fields_input_method_check check (input_method is null or input_method in ('typed', 'drawn', 'auto')),
  value text,
  image_key text,
  checked boolean,
  submitted_at bigint,
  created_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  updated_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  options jsonb,
  group_id text,
  constraint fields_check check (x + width <= 1.000001),
  constraint fields_check1 check (y + height <= 1.000001),
  constraint fields_options_only_on_dropdowns check (
    options is null or (type = 'dropdown' and json_type(options) = 'array')
  ),
  constraint fields_group_only_on_radios check (
    (type = 'radio') = (group_id is not null)
  ),
  constraint fields_signer_envelope_fk
    foreign key (signer_id, envelope_id)
    references signers (id, envelope_id)
    on delete cascade
);

create index idx_fields_signer_envelope on fields (signer_id, envelope_id);
create index idx_fields_envelope_page on fields (envelope_id, page, created_at, id);
create index idx_fields_envelope_group on fields (envelope_id, group_id)
  where group_id is not null;

create table audit_events (
  id text not null primary key,
  envelope_id text not null references envelopes (id) on delete cascade,
  event text not null,
  actor_type text not null constraint audit_events_actor_type_check check (actor_type in ('sender', 'signer', 'system')),
  actor_email text,
  ip_address text,
  user_agent text,
  metadata jsonb,
  created_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  sequence integer,
  prev_hash text,
  row_hash text,
  constraint audit_events_event_check check (
    event in (
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
      'signer_corrected'
    )
  )
);

create index idx_audit_events_envelope_event on audit_events (envelope_id, event);
create index idx_audit_events_envelope_created_at
  on audit_events (envelope_id, created_at, id);
create index idx_audit_events_envelope_event_signer_id
  on audit_events (envelope_id, event, (metadata ->> 'signerId'));
create unique index idx_audit_events_envelope_sequence
  on audit_events (envelope_id, sequence)
  where sequence is not null;

create table account_closure_requests (
  user_id text not null primary key references "user" (id) on delete cascade,
  requested_at bigint not null,
  export_expires_at bigint not null,
  purge_after_at bigint not null,
  updated_at bigint not null,
  constraint account_closure_requests_check check (export_expires_at >= requested_at),
  constraint account_closure_requests_check1 check (purge_after_at >= export_expires_at)
);

create index idx_account_closure_requests_purge_after
  on account_closure_requests (purge_after_at, requested_at);

create table app_settings (
  id boolean primary key not null default 1 constraint app_settings_id_check check (id),
  organization_name text,
  sender_address text,
  support_address text,
  signup_mode text not null default 'closed'
    constraint app_settings_signup_mode_check check (signup_mode in ('closed', 'domains', 'open')),
  allowed_email_domains text[] not null default '[]',
  terms_url text,
  privacy_url text,
  email_ready_at bigint,
  setup_completed_at bigint,
  created_at bigint not null,
  updated_at bigint not null,
  retention_days integer constraint app_settings_retention_days_check check (retention_days is null or retention_days >= 30),
  brand_color text constraint app_settings_brand_color_check check (
    brand_color is null
    or brand_color glob '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  logo_content_type text,
  logo_data bytea,
  logo_hash text,
  part11_mode boolean not null default 0,
  require_two_factor boolean not null default 0,
  session_idle_minutes integer constraint app_settings_session_idle_minutes_check check (
    session_idle_minutes is null
    or (session_idle_minutes >= 5 and session_idle_minutes <= 1440)
  ),
  session_max_hours integer constraint app_settings_session_max_hours_check check (
    session_max_hours is null
    or (session_max_hours >= 1 and session_max_hours <= 168)
  ),
  constraint app_settings_logo_check check (
    (logo_data is null and logo_content_type is null and logo_hash is null)
    or (
      logo_data is not null
      and logo_content_type is not null
      and logo_hash is not null
      and length(logo_hash) = 16
      and logo_hash not glob '*[^0-9a-f]*'
      and logo_content_type in ('image/png', 'image/jpeg', 'image/webp')
      and length(logo_data) >= 1
      and length(logo_data) <= 524288
    )
  )
);

create table rate_limits (
  key text not null primary key,
  count integer not null,
  expires_at bigint not null
);

create index rate_limits_expires_at_idx on rate_limits (expires_at);

create table seal_keys (
  id text not null primary key,
  certificate_pem text not null,
  encrypted_private_key text not null,
  created_at bigint not null,
  retired_at bigint
);

create unique index idx_seal_keys_single_active on seal_keys ((1))
  where retired_at is null;

create table system_audit_events (
  id text not null primary key,
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

create index idx_system_audit_events_created_at
  on system_audit_events (created_at desc);

create table templates (
  id text not null primary key,
  user_id text not null references "user" (id) on delete cascade,
  name text not null
    constraint templates_name_check check (length(trim(name)) >= 1 and length(trim(name)) <= 160),
  source_pdf_key text not null,
  source_pdf_filename text not null,
  source_pdf_size_bytes bigint not null constraint templates_source_pdf_size_bytes_check check (source_pdf_size_bytes > 0),
  page_count integer not null constraint templates_page_count_check check (page_count > 0),
  roles jsonb not null constraint templates_roles_check check (
    case
      when json_type(roles) = 'array'
        then json_array_length(roles) >= 1 and json_array_length(roles) <= 10
      else 0
    end
  ),
  fields jsonb not null constraint templates_fields_check check (json_type(fields) = 'array'),
  created_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  updated_at bigint not null default (cast(round(unixepoch('subsec')) as integer))
);

create index idx_templates_user_created_at on templates (user_id, created_at desc, id);

create table pending_file_deletions (
  storage_key text not null primary key,
  envelope_id text not null,
  queued_at bigint not null,
  last_tried_at bigint
);

-- Postgres orders last_tried_at nulls first here; SQLite puts nulls first
-- in ascending order anyway.
create index pending_file_deletions_order_idx
  on pending_file_deletions (last_tried_at, queued_at);

create table provider_signing_sessions (
  id text not null primary key,
  envelope_id text not null references envelopes (id) on delete cascade,
  signer_id text not null references signers (id) on delete cascade,
  provider text not null,
  level text not null constraint provider_signing_sessions_level_check check (level in ('advanced', 'qualified')),
  state text not null default 'pending'
    constraint provider_signing_sessions_state_check check (state in ('pending', 'signing', 'completed', 'failed')),
  base_sha256 text,
  revision_key text not null,
  content_digest text not null,
  secret_data text not null,
  submitted_at bigint not null,
  created_at bigint not null,
  expires_at bigint not null,
  completed_at bigint
);

create index idx_provider_signing_sessions_envelope
  on provider_signing_sessions (envelope_id);
create index idx_provider_signing_sessions_signer
  on provider_signing_sessions (signer_id, state);
