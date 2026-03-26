type RateLimitResult = {
  remaining: number;
  resetAt: number;
};

type SlidingWindowEntry = {
  expiresAt: number;
  timestamps: number[];
};

declare global {
  var __signudocRateLimitStore: Map<string, SlidingWindowEntry> | undefined;
  var __signudocRateLimitSweepAt: number | undefined;
}

const rateLimitStore =
  globalThis.__signudocRateLimitStore ??
  (globalThis.__signudocRateLimitStore = new Map<string, SlidingWindowEntry>());

const RATE_LIMIT_SWEEP_INTERVAL_MS = 60 * 1000;

function sweepExpiredRateLimitEntries(now: number) {
  const nextSweepAt = globalThis.__signudocRateLimitSweepAt ?? 0;

  if (nextSweepAt > now) {
    return;
  }

  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.expiresAt <= now) {
      rateLimitStore.delete(key);
    }
  }

  globalThis.__signudocRateLimitSweepAt = now + RATE_LIMIT_SWEEP_INTERVAL_MS;
}

export class RateLimitExceededError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many requests. Please try again soon.");
    this.name = "RateLimitExceededError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function enforceSlidingWindowRateLimit(input: {
  key: string;
  limit: number;
  now?: number;
  windowMs: number;
}): RateLimitResult {
  const now = input.now ?? Date.now();
  const windowStart = now - input.windowMs;
  sweepExpiredRateLimitEntries(now);
  const entry = rateLimitStore.get(input.key) ?? {
    expiresAt: windowStart,
    timestamps: [],
  };

  entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > windowStart);

  if (entry.timestamps.length === 0) {
    rateLimitStore.delete(input.key);
  } else {
    entry.expiresAt = (entry.timestamps.at(-1) ?? now) + input.windowMs;
    rateLimitStore.set(input.key, entry);
  }

  if (entry.timestamps.length >= input.limit) {
    const oldestTimestamp = entry.timestamps[0] ?? now;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldestTimestamp + input.windowMs - now) / 1000),
    );
    throw new RateLimitExceededError(retryAfterSeconds);
  }

  entry.timestamps.push(now);
  entry.expiresAt = now + input.windowMs;
  rateLimitStore.set(input.key, entry);

  const oldestTimestamp = entry.timestamps[0] ?? now;

  return {
    remaining: Math.max(0, input.limit - entry.timestamps.length),
    resetAt: oldestTimestamp + input.windowMs,
  };
}

export function clearRateLimitStoreForTests() {
  rateLimitStore.clear();
  globalThis.__signudocRateLimitSweepAt = undefined;
}
