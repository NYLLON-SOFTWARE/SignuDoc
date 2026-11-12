import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "../db/test-database.ts";
import { consumeRateLimit, deleteExpiredRateLimits } from "./rate-limit.ts";

// The rate limit statement against a real Postgres. Run with
// `npm run test:db`.
//
// Time is passed in rather than read from the clock, and set in the future
// so that nothing else clearing finished windows can take these rows.

const MINUTE = 60 * 1000;
const START = 4_000_000_000_000;

let database: pg.Pool;

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.query(
    "delete from public.rate_limits where expires_at >= $1",
    [START],
  );
  await database.end();
});

function uniqueKey(label: string) {
  return `dbtest:${label}:${randomUUID()}`;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

test("requests up to the limit pass, the next one waits, and the count starts over when the window ends", async () => {
  const input = { key: uniqueKey("window"), limit: 2, windowMs: MINUTE };
  const at = (offset: number) =>
    consumeRateLimit({ ...input, now: START + offset }, { database });

  assert.deepEqual(await at(0), { allowed: true, retryAfterSeconds: 60 });
  assert.deepEqual(await at(1000), { allowed: true, retryAfterSeconds: 59 });
  assert.deepEqual(await at(15_000), { allowed: false, retryAfterSeconds: 45 });
  // Trying again while blocked does not push the window back.
  assert.deepEqual(await at(59_000), { allowed: false, retryAfterSeconds: 1 });
  assert.deepEqual(await at(MINUTE), { allowed: true, retryAfterSeconds: 60 });
  assert.deepEqual(await at(MINUTE + 1), {
    allowed: true,
    retryAfterSeconds: 60,
  });
  assert.equal((await at(MINUTE + 2)).allowed, false);
});

test("only a hash of the key is stored", async () => {
  const key = uniqueKey("hashed");

  await consumeRateLimit(
    { key, limit: 1, now: START, windowMs: MINUTE },
    { database },
  );

  const stored = await database.query<{ key: string }>(
    "select key from public.rate_limits where key = any($1)",
    [[key, hash(key)]],
  );

  assert.deepEqual(
    stored.rows.map((row) => row.key),
    [hash(key)],
  );
});

test("requests that arrive together are each counted once", async () => {
  const key = uniqueKey("burst");
  const decisions = await Promise.all(
    Array.from({ length: 40 }, () =>
      consumeRateLimit(
        { key, limit: 5, now: START, windowMs: MINUTE },
        { database },
      ),
    ),
  );

  assert.equal(decisions.filter((decision) => decision.allowed).length, 5);

  const stored = await database.query<{ count: number }>(
    "select count from public.rate_limits where key = $1",
    [hash(key)],
  );

  assert.equal(stored.rows[0]?.count, 40);
});

test("each key has its own count", async () => {
  const first = uniqueKey("separate");
  const second = uniqueKey("separate");
  const limit = { limit: 1, now: START, windowMs: MINUTE };

  assert.equal(
    (await consumeRateLimit({ ...limit, key: first }, { database })).allowed,
    true,
  );
  assert.equal(
    (await consumeRateLimit({ ...limit, key: second }, { database })).allowed,
    true,
  );
  assert.equal(
    (await consumeRateLimit({ ...limit, key: first }, { database })).allowed,
    false,
  );
});

test("finished windows are cleared and live ones are kept", async () => {
  const ended = uniqueKey("ended");
  const live = uniqueKey("live");

  await consumeRateLimit(
    { key: ended, limit: 1, now: START, windowMs: MINUTE },
    { database },
  );
  await consumeRateLimit(
    { key: live, limit: 1, now: START + 1, windowMs: MINUTE },
    { database },
  );

  // The first window ends exactly now; the second has a millisecond left.
  const removed = await deleteExpiredRateLimits(database, START + MINUTE);
  const remaining = await database.query<{ key: string }>(
    "select key from public.rate_limits where key = any($1)",
    [[hash(ended), hash(live)]],
  );

  assert.ok(removed >= 1);
  assert.deepEqual(
    remaining.rows.map((row) => row.key),
    [hash(live)],
  );
});
