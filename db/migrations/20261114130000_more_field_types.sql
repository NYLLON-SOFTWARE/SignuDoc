-- Three more kinds of field: a number, a dropdown and a radio button.
--
-- A dropdown carries its list of choices in `options`. Radio buttons are
-- placed one by one, each its own row, and the buttons that belong together
-- share a `group_id`; the signer picks one button in each group. The name
-- of a radio button is its `label`.

alter table public.fields
  drop constraint if exists fields_type_check;

alter table public.fields
  add constraint fields_type_check check (
    type in (
      'signature',
      'initials',
      'date',
      'text',
      'checkbox',
      'number',
      'dropdown',
      'radio'
    )
  );

alter table public.fields
  add column if not exists options jsonb,
  add column if not exists group_id text;

alter table public.fields
  drop constraint if exists fields_options_only_on_dropdowns;

alter table public.fields
  add constraint fields_options_only_on_dropdowns check (
    options is null
    or (type = 'dropdown' and jsonb_typeof(options) = 'array')
  );

alter table public.fields
  drop constraint if exists fields_group_only_on_radios;

alter table public.fields
  add constraint fields_group_only_on_radios check (
    (type = 'radio') = (group_id is not null)
  );

create index if not exists idx_fields_envelope_group
  on public.fields(envelope_id, group_id)
  where group_id is not null;
