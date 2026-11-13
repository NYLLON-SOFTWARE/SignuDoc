-- Templates: a document, its fields and its signing order, kept so the same
-- thing can be sent again without setting it up again.
--
-- A template holds no one's name or address. Each place in the signing
-- order is a role with a label ("Client", "Landlord"), and the person who
-- fills it is named when the template is used.
--
-- Roles and fields are stored whole, as JSON, because they are only ever
-- read and written together. The application checks their contents with the
-- same rules it applies to the fields of an envelope.
--   roles:  [{ "id": "...", "name": "Client" }, ...] in signing order
--   fields: placed fields, each with "signerId" naming one of the roles

create table if not exists public.templates (
  id text primary key,
  user_id text not null references public."user"(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  source_pdf_key text not null,
  source_pdf_filename text not null,
  source_pdf_size_bytes bigint not null check (source_pdf_size_bytes > 0),
  page_count integer not null check (page_count > 0),
  roles jsonb not null,
  fields jsonb not null,
  created_at bigint not null default (extract(epoch from now())::bigint),
  updated_at bigint not null default (extract(epoch from now())::bigint),
  constraint templates_roles_check check (
    case
      when jsonb_typeof(roles) = 'array'
        then jsonb_array_length(roles) between 1 and 10
      else false
    end
  ),
  constraint templates_fields_check check (jsonb_typeof(fields) = 'array')
);

create index if not exists idx_templates_user_created_at
  on public.templates(user_id, created_at desc, id);
