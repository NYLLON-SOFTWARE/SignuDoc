-- sqlite: rebuilds tables
--
-- SQLite version of db/migrations/20261119090000_signing_steps.sql: the step
-- of the signing order each signer is in, and up to 100 roles in a template.
-- See that file for what each change is for.
--
-- A CHECK constraint cannot be changed in place here, so templates is made
-- again with the new one (see db/sqlite/migrate.mjs).

alter table signers add column signing_step integer
  constraint signers_signing_step_check check (signing_step is null or signing_step > 0)
  constraint signers_copy_recipient_has_no_step check (role = 'signer' or signing_step is null);

update signers
set signing_step = sign_order
where role = 'signer'
  and signing_step is null;

drop index if exists idx_signers_single_notified;

create table templates_new (
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
        then json_array_length(roles) >= 1 and json_array_length(roles) <= 100
      else 0
    end
  ),
  fields jsonb not null constraint templates_fields_check check (json_type(fields) = 'array'),
  created_at bigint not null default (cast(round(unixepoch('subsec')) as integer)),
  updated_at bigint not null default (cast(round(unixepoch('subsec')) as integer))
);

insert into templates_new (
  id, user_id, name, source_pdf_key, source_pdf_filename,
  source_pdf_size_bytes, page_count, roles, fields, created_at, updated_at
)
select
  id, user_id, name, source_pdf_key, source_pdf_filename,
  source_pdf_size_bytes, page_count, roles, fields, created_at, updated_at
from templates;

drop table templates;

alter table templates_new rename to templates;

create index idx_templates_user_created_at on templates (user_id, created_at desc, id);
