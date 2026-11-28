alter table public.envelopes
  add column invitation_subject text check (length(invitation_subject) between 1 and 160),
  add column invitation_message text check (length(invitation_message) between 1 and 2000);

alter table public.templates
  add column invitation_subject text check (length(invitation_subject) between 1 and 160),
  add column invitation_message text check (length(invitation_message) between 1 and 2000);
