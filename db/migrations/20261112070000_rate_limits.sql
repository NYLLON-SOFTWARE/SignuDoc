-- Rate limit counters.
--
-- One row per thing being limited (a hash of "which limit, for whom"), with
-- how many requests it has made in its current window and when that window
-- ends. Kept in Postgres because a deployment on Vercel runs as many
-- short-lived instances that share nothing else.

create table if not exists public.rate_limits (
  key text primary key,
  count integer not null,
  expires_at bigint not null
);

-- For clearing out windows that have ended.
create index if not exists rate_limits_expires_at_idx
  on public.rate_limits (expires_at);
