-- Install-wide settings and the administrator role.
--
-- app_settings holds exactly one row (the boolean primary key can only be
-- true). It is written by the first-run setup page and by an administrator
-- in Settings. Until that row exists the app behaves as it did before this
-- migration: anyone can create an account, and email addresses come from
-- environment variables.

create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  organization_name text,
  sender_address text,
  support_address text,
  signup_mode text not null default 'closed'
    check (signup_mode in ('closed', 'domains', 'open')),
  allowed_email_domains text[] not null default '{}',
  terms_url text,
  privacy_url text,
  -- Set once email has been seen working from the current sender address,
  -- and cleared whenever that address changes.
  email_ready_at bigint,
  setup_completed_at bigint,
  created_at bigint not null,
  updated_at bigint not null
);

alter table public."user"
  add column if not exists role text not null default 'user';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_role_check'
  ) then
    alter table public."user"
      add constraint user_role_check check (role in ('user', 'admin'));
  end if;
end
$$;

create index if not exists user_role_admin_idx
  on public."user" (role) where role = 'admin';
