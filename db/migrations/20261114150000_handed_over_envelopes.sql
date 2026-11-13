-- When an account is closed, its finished envelopes are handed to an
-- administrator, because they are the organization's records and not the
-- person's who is leaving.
--
-- This marks an envelope that was handed over, and when, so that it can be
-- told apart from the envelopes its keeper sent themselves. Someone who
-- stops being an administrator keeps their own envelopes, and the marked
-- ones move on to an administrator who stays.

alter table public.envelopes
  add column if not exists handed_over_at bigint;
