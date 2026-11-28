create table public.google_drive_filings (
  envelope_id text primary key references public.envelopes(id) on delete cascade,
  folder_id text not null,
  signed_file_id text not null,
  certificate_file_id text not null,
  signed_filed boolean not null default false,
  certificate_filed boolean not null default false,
  last_attempt_at bigint not null
);

create index idx_envelopes_owner_completed_for_drive
  on public.envelopes (user_id, completed_at, id)
  where status = 'completed';
