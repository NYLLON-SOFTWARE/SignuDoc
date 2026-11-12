import { createHash, timingSafeEqual } from "node:crypto";

import { getDb, type DbPool } from "./db/connection.ts";
import { runRetentionSweep, type RetentionSweepSummary } from "./retention.ts";
import {
  consumeRateLimit,
  deleteExpiredRateLimits,
} from "./security/rate-limit.ts";
import type { StorageService } from "./services/storage.ts";
import { isMissingSchemaError } from "./settings.ts";
import { getEnv, type EnvSource } from "./utils/env.ts";

// The daily cleanup: stale drafts, queued account deletions, expired
// download links and finished rate limit windows.
//
// On Vercel it is called by a cron job (see vercel.json). A click-to-deploy
// install has no secret for that call, because nobody typed one in, so the
// job protects itself instead: it runs at most once an hour, never twice at
// the same time, and tells an anonymous caller nothing. Calling it early
// only does work that was due anyway.

export const RETENTION_ADVISORY_LOCK_ID = 746108323;
const ANONYMOUS_RUN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * - authorized: the caller proved it knows a job secret.
 * - anonymous: no secret is configured, so there is nothing to prove. The
 *   run is rationed.
 * - denied: a secret is configured and the caller did not present it.
 */
export type RetentionCaller = "anonymous" | "authorized" | "denied";

export type RetentionJobOutcome =
  | { status: "ran"; summary: RetentionSweepSummary }
  | { status: "skipped"; reason: "already_running" | "ran_recently" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function matchesAnySecret(presented: string, secrets: string[]): boolean {
  const presentedDigest = digest(presented);
  let matched = false;

  // Every secret is compared, so the time taken does not depend on which
  // one matched.
  for (const secret of secrets) {
    if (timingSafeEqual(presentedDigest, digest(secret))) {
      matched = true;
    }
  }

  return matched;
}

/**
 * Decides how much to trust a request to run the cleanup.
 *
 * Vercel sends CRON_SECRET as a bearer token on cron calls when that
 * variable is set, so setting it locks the route to Vercel's own calls.
 * RETENTION_JOB_SECRET is the older name, for a scheduler on another host.
 * If either is set, one of them has to be presented.
 * https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
 */
export function identifyRetentionCaller(
  authorizationHeader: string | null,
  env: EnvSource = process.env,
): RetentionCaller {
  const { cronSecret, retentionJobSecret } = getEnv(env).internal;
  const secrets = [cronSecret, retentionJobSecret].filter(
    (secret): secret is string => Boolean(secret),
  );

  if (secrets.length === 0) {
    return "anonymous";
  }

  const presented = /^Bearer (.+)$/.exec(authorizationHeader ?? "")?.[1];

  return presented && matchesAnySecret(presented, secrets)
    ? "authorized"
    : "denied";
}

/**
 * True when Vercel's cron is being turned away only because the secret is
 * stored under the name Vercel does not send. Worth saying in the log:
 * nothing else would show that the daily cleanup never runs.
 */
export function isCronLockedOutByOlderSecret(
  userAgent: string | null,
  env: EnvSource = process.env,
): boolean {
  const { cronSecret, retentionJobSecret } = getEnv(env).internal;

  return Boolean(
    retentionJobSecret && !cronSecret && userAgent?.startsWith("vercel-cron/"),
  );
}

/**
 * Runs the cleanup unless another run holds the lock or, for an anonymous
 * caller, one ran within the last hour.
 */
export async function runRetentionJob({
  caller,
  database = getDb(),
  storageService,
}: {
  caller: Exclude<RetentionCaller, "denied">;
  database?: DbPool;
  storageService?: StorageService;
}): Promise<RetentionJobOutcome> {
  if (caller === "anonymous") {
    const ration = await consumeRateLimit(
      {
        key: "job:retention",
        limit: 1,
        windowMs: ANONYMOUS_RUN_INTERVAL_MS,
      },
      { database },
    );

    if (!ration.allowed) {
      return { reason: "ran_recently", status: "skipped" };
    }
  }

  // The lock lives as long as this transaction, which is held open on its
  // own connection while the cleanup works through the pool. A transaction
  // lock is used because it also holds through a connection pooler.
  const lockClient = await database.connect();

  try {
    await lockClient.query("begin");

    const lock = await lockClient.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock($1) as locked",
      [RETENTION_ADVISORY_LOCK_ID],
    );

    if (!lock.rows[0]?.locked) {
      return { reason: "already_running", status: "skipped" };
    }

    const summary = await runRetentionSweep({ database, storageService });

    await deleteExpiredRateLimits(database).catch((error: unknown) => {
      // A database from before rate limits were kept in it has no table to
      // clear, which is fine.
      if (!isMissingSchemaError(error)) {
        console.error("Clearing finished rate limit windows failed:", error);
      }
    });

    return { status: "ran", summary };
  } finally {
    await lockClient.query("rollback").catch(() => undefined);
    lockClient.release();
  }
}

export function retentionSweepFailed(summary: RetentionSweepSummary): boolean {
  return (
    summary.accountPurgeFailures.length > 0 ||
    summary.draftDeletionFailures.length > 0
  );
}
