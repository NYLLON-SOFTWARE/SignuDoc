import { createHash } from "node:crypto";

import { getDb, type DbExecutor } from "../db/connection.ts";

// Rate limits are counted in Postgres, in the rate_limits table: on Vercel
// the app runs as many short-lived instances, and a count kept in one of
// them is not a limit. Each check is a single statement, so two requests
// that arrive together cannot both read the old count.
//
// If the database cannot be asked (no database yet, or a preview deployment
// whose shared database does not have the table), the count is kept in this
// instance's memory instead, which is what the app did before.

export type RateLimitDecision = {
  allowed: boolean;
  /** Seconds until the current window ends. At least 1 when not allowed. */
  retryAfterSeconds: number;
};

type RateLimitInput = {
  key: string;
  limit: number;
  now?: number;
  windowMs: number;
};

type ConsumeRateLimitOptions = {
  database?: DbExecutor;
};

type MemoryEntry = {
  count: number;
  expiresAt: number;
};

declare global {
  var __signudocRateLimitStore: Map<string, MemoryEntry> | undefined;
  var __signudocRateLimitSweepAt: number | undefined;
  var __signudocRateLimitWarnedAt: number | undefined;
}

const memoryStore = (globalThis.__signudocRateLimitStore ??= new Map<
  string,
  MemoryEntry
>());

const MEMORY_SWEEP_INTERVAL_MS = 60 * 1000;
const FALLBACK_WARNING_INTERVAL_MS = 60 * 1000;
// One request in this many also clears out windows that have ended. The
// daily cleanup job does the same, so this only matters where there is none.
const DATABASE_SWEEP_ODDS = 200;

// The key names who is being limited, and for the signing pages that
// includes the signing token. Only a hash of it is stored.
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function toDecision(
  count: number,
  expiresAt: number,
  input: RateLimitInput,
  now: number,
): RateLimitDecision {
  return {
    allowed: count <= input.limit,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
  };
}

function sweepMemoryStore(now: number) {
  if ((globalThis.__signudocRateLimitSweepAt ?? 0) > now) {
    return;
  }

  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }

  globalThis.__signudocRateLimitSweepAt = now + MEMORY_SWEEP_INTERVAL_MS;
}

/** The same counting as the database does, for one instance only. */
export function consumeRateLimitInMemory(
  input: RateLimitInput,
): RateLimitDecision {
  const now = input.now ?? Date.now();

  sweepMemoryStore(now);

  const existing = memoryStore.get(input.key);
  const entry =
    existing && existing.expiresAt > now
      ? { count: existing.count + 1, expiresAt: existing.expiresAt }
      : { count: 1, expiresAt: now + input.windowMs };

  memoryStore.set(input.key, entry);

  return toDecision(entry.count, entry.expiresAt, input, now);
}

function warnAboutFallback(error: unknown) {
  const now = Date.now();

  if ((globalThis.__signudocRateLimitWarnedAt ?? 0) > now) {
    return;
  }

  globalThis.__signudocRateLimitWarnedAt = now + FALLBACK_WARNING_INTERVAL_MS;
  console.warn(
    "[rate-limit] Counting in memory because the database could not be used:",
    error instanceof Error ? error.message : error,
  );
}

/**
 * Removes windows that have ended. Returns how many rows went. Called by the
 * cleanup job, and now and then by the limiter itself.
 */
export async function deleteExpiredRateLimits(
  database: DbExecutor = getDb(),
  now: number = Date.now(),
): Promise<number> {
  const result = await database.query(
    "delete from public.rate_limits where expires_at <= $1",
    [now],
  );

  return result.rowCount ?? 0;
}

/**
 * Counts one request against a limit and says whether it is within it.
 *
 * Windows are fixed: the first request starts one, and the count resets
 * when it ends. A request over the limit is still counted, but it does not
 * extend the window, so a client that keeps trying is let back in when the
 * window ends rather than never.
 */
export async function consumeRateLimit(
  input: RateLimitInput,
  { database }: ConsumeRateLimitOptions = {},
): Promise<RateLimitDecision> {
  const now = input.now ?? Date.now();

  try {
    const executor = database ?? getDb();
    const result = await executor.query<{
      count: number;
      expires_at: number;
    }>(
      `
        insert into public.rate_limits as current (key, count, expires_at)
        values ($1, 1, $2::bigint + $3::bigint)
        on conflict (key) do update set
          count = case
            when current.expires_at <= $2::bigint then 1
            else least(current.count + 1, 1000000)
          end,
          expires_at = case
            when current.expires_at <= $2::bigint
              then $2::bigint + $3::bigint
            else current.expires_at
          end
        returning count, expires_at
      `,
      [hashKey(input.key), now, input.windowMs],
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error("The rate limit statement returned no row.");
    }

    if (Math.floor(Math.random() * DATABASE_SWEEP_ODDS) === 0) {
      void deleteExpiredRateLimits(executor, now).catch(() => undefined);
    }

    return toDecision(row.count, Number(row.expires_at), input, now);
  } catch (error) {
    warnAboutFallback(error);

    return consumeRateLimitInMemory({ ...input, now });
  }
}

export function clearRateLimitStoreForTests() {
  memoryStore.clear();
  globalThis.__signudocRateLimitSweepAt = undefined;
  globalThis.__signudocRateLimitWarnedAt = undefined;
}
