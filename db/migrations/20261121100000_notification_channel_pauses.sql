-- A chat tool's request to wait, shared by every notification run.
--
-- * notification_channel_pauses: when a chat tool asks for a pause (Slack's
--   HTTP 429 and Retry-After), until when. Every run, in any server
--   instance, checks it before sending to that tool, so a run that starts
--   during the pause holds its messages back too instead of sending them
--   straight away. A row whose time has passed means nothing and is left
--   for the next pause to overwrite.

create table if not exists public.notification_channel_pauses (
  channel text primary key,
  paused_until bigint not null,
  updated_at bigint not null
);
