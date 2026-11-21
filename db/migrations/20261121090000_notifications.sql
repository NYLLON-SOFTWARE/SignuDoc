-- Notifications: messages about envelopes sent to chat tools such as Slack.
-- See docs/notifications.md and src/lib/notifications/.
--
-- * notification_settings: one row, what an administrator set up in
--   Settings. The Slack bot token is stored encrypted with a key derived
--   from the auth secret (src/lib/notifications/store.ts); SLACK_BOT_TOKEN,
--   when set, wins over it.
-- * notification_events: what happened, one row each, waiting to be turned
--   into deliveries. A row is written for every envelope audit event by a
--   trigger, in the same transaction as the audit event itself, so nothing
--   that happened can be missed and nothing rolled back is ever announced.
--   The notifications job adds rows of its own (a deadline coming up, an
--   envelope with no activity). dedupe_key makes each of those happen once:
--   'audit:<audit event id>', 'envelope_stuck:<envelope id>' and so on.
--   Which events are worth a message is decided in code, so a new kind of
--   audit event needs no migration to be announced. payload holds only who
--   did it (names and addresses), never anything from the document or a
--   decline reason. seq tells two events in the same second apart by the
--   order they were queued in.
-- * notification_deliveries: one message to one place (a person's direct
--   messages or a channel) for one event, with its retries. The unique key
--   keeps an event from being delivered twice to the same place.
-- * notification_rules: an administrator's "these events go to this
--   channel".
-- * notification_preferences: what a person chose for their own direct
--   messages. No row means the default for that event.
-- * notification_identities: who a person is in a chat tool (their Slack
--   user id), found by their email address and kept so it is not looked up
--   for every message.
-- * notification_threads: the one message per envelope per place. In a
--   channel the first post starts a thread that later events reply in, and
--   the first post is edited to show where the envelope stands; in a
--   person's direct messages progress edits one message. A row remembers
--   that message (the conversation and the message's own id, Slack's "ts").
--   Before a delivery posts or edits it, it takes the row's short lease in a
--   single statement, so two runs never both start a thread for the same
--   envelope. parent_event_at and parent_event_seq say which event the
--   message shows, so a late retry of an older event never puts back an
--   older headline. A person's place is their address in the chat tool (the
--   Slack user found by their email), so a new address starts a new
--   message instead of editing one in the old account's messages.
-- * notification_channel_accounts: which account the people and messages
--   remembered for a channel were found with (for Slack, a hash of the bot
--   token, wherever it comes from). A run that finds the channel set up
--   with another forgets them: another workspace's ids mean nothing here.

create table if not exists public.notification_settings (
  id boolean primary key default true check (id),
  slack_bot_token_encrypted text,
  direct_messages boolean not null default true,
  expiring_days integer check (expiring_days between 0 and 60),
  stuck_days integer check (stuck_days between 0 and 60),
  updated_at bigint not null
);

create table if not exists public.notification_events (
  id text primary key,
  dedupe_key text not null unique,
  source text not null check (source in ('audit', 'job')),
  event text not null,
  envelope_id text references public.envelopes(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at bigint not null,
  queued_at bigint not null default (extract(epoch from now())::bigint),
  processed_at bigint,
  seq bigserial
);

create index if not exists notification_events_unprocessed_idx
  on public.notification_events (queued_at)
  where processed_at is null;

create index if not exists notification_events_processed_idx
  on public.notification_events (processed_at)
  where processed_at is not null;

-- Finding a newer delivery for the same envelope (burst collapse).
create index if not exists notification_events_envelope_idx
  on public.notification_events (envelope_id, created_at)
  where envelope_id is not null;

create table if not exists public.notification_rules (
  id text primary key,
  channel text not null,
  events text[] not null check (cardinality(events) > 0),
  destination text not null check (length(destination) between 1 and 200),
  destination_name text check (length(destination_name) <= 200),
  enabled boolean not null default true,
  created_at bigint not null,
  updated_at bigint not null,
  created_by text
);

create index if not exists notification_rules_channel_idx
  on public.notification_rules (channel)
  where enabled;

create table if not exists public.notification_deliveries (
  id text primary key,
  event_id text not null
    references public.notification_events(id) on delete cascade,
  channel text not null,
  target_kind text not null check (target_kind in ('user', 'channel')),
  -- A user id for 'user', the chat tool's channel id for 'channel'.
  target text not null,
  rule_id text references public.notification_rules(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at bigint not null,
  locked_until bigint,
  -- A short error code from the chat tool, never a response body.
  last_error text check (length(last_error) <= 200),
  created_at bigint not null,
  updated_at bigint not null,
  sent_at bigint,
  constraint notification_deliveries_once
    unique (event_id, channel, target_kind, target)
);

create index if not exists notification_deliveries_due_idx
  on public.notification_deliveries (next_attempt_at)
  where status in ('pending', 'sending');

create index if not exists notification_deliveries_recent_idx
  on public.notification_deliveries (updated_at desc);

create table if not exists public.notification_preferences (
  user_id text not null references public."user"(id) on delete cascade,
  channel text not null,
  event text not null,
  enabled boolean not null,
  updated_at bigint not null,
  primary key (user_id, channel, event)
);

create table if not exists public.notification_identities (
  user_id text not null references public."user"(id) on delete cascade,
  channel text not null,
  -- The address it was looked up by; a changed address is looked up again.
  lookup_email text not null,
  -- Null when nobody with that address was found.
  external_id text,
  checked_at bigint not null,
  primary key (user_id, channel)
);

create table if not exists public.notification_threads (
  envelope_id text not null
    references public.envelopes(id) on delete cascade,
  channel text not null,
  target_kind text not null check (target_kind in ('user', 'channel')),
  target text not null,
  conversation text check (length(conversation) <= 100),
  message_ts text check (length(message_ts) <= 100),
  parent_event_at bigint,
  parent_event_seq bigint,
  -- The delivery holding the lease, and until when.
  lease_owner text,
  lease_until bigint,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (envelope_id, channel, target_kind, target)
);

create index if not exists notification_threads_updated_idx
  on public.notification_threads (updated_at);

create table if not exists public.notification_channel_accounts (
  channel text primary key,
  account_key text not null check (length(account_key) <= 200),
  updated_at bigint not null
);

-- Every envelope audit event but the note that an email went out, which is
-- frequent and never announced, queued in the audit event's transaction.
create or replace function public.signudoc_queue_notification_event()
returns trigger
language plpgsql
as $$
begin
  insert into public.notification_events (
    id, dedupe_key, source, event, envelope_id, payload, created_at
  ) values (
    gen_random_uuid()::text,
    'audit:' || new.id,
    'audit',
    new.event,
    new.envelope_id,
    jsonb_strip_nulls(jsonb_build_object(
      'actorEmail', new.actor_email,
      'actorType', new.actor_type,
      'signerEmail', new.metadata->>'signerEmail',
      'signerId', new.metadata->>'signerId',
      'signerName', new.metadata->>'signerName'
    )),
    new.created_at
  )
  on conflict (dedupe_key) do nothing;

  return null;
end;
$$;

drop trigger if exists audit_events_queue_notification on public.audit_events;

create trigger audit_events_queue_notification
  after insert on public.audit_events
  for each row
  when (new.event <> 'email_sent')
  execute function public.signudoc_queue_notification_event();
