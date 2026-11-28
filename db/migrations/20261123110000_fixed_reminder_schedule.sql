alter table public.envelopes
  add column if not exists reminder_schedule text
    check (reminder_schedule is null or (
      reminder_schedule = 'days_3_and_7' and reminder_interval_days is null
    ));

alter table public.signers
  add column if not exists last_automatic_reminder_day smallint
    check (last_automatic_reminder_day in (3, 7));

create index if not exists idx_envelopes_fixed_reminders
  on public.envelopes(id)
  where status = 'sent' and reminder_schedule is not null;
