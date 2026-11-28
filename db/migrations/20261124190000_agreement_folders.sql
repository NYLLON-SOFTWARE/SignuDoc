-- Existing teams continue to share unfiled envelopes. A folder has its own
-- membership and grants access only to envelopes filed there.
alter table public.teams add column is_folder boolean not null default false;

alter table public.envelopes
  add column folder_id text references public.teams(id) on delete restrict;

create index envelopes_folder_created_idx
  on public.envelopes (folder_id, created_at desc, id desc)
  where folder_id is not null;

drop index public.teams_name_unique;
create unique index teams_name_unique
  on public.teams (is_folder, lower(name));
