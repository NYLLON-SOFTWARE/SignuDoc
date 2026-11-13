import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  RETENTION_ADVISORY_LOCK_ID,
  runRetentionJob,
} from "./retention-job.ts";
import { createStorageService } from "./services/storage.ts";

// The cleanup job's hourly ration and its lock, against a real Postgres.
// Run with `npm run test:db`.

const RATION_KEY = createHash("sha256").update("job:retention").digest("hex");

let database: pg.Pool;
let storageDir: string;

function run(caller: "anonymous" | "authorized") {
  return runRetentionJob({
    caller,
    database,
    storageService: createStorageService({
      env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
    }),
  });
}

async function clearRation() {
  await database.query("delete from public.rate_limits where key = $1", [
    RATION_KEY,
  ]);
}

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-retention-"));
});

after(async () => {
  await clearRation();
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

test("a caller with no secret gets one run an hour", async () => {
  await clearRation();

  const first = await run("anonymous");

  assert.equal(first.status, "ran");
  assert.deepEqual(await run("anonymous"), {
    reason: "ran_recently",
    status: "skipped",
  });
  assert.deepEqual(await run("anonymous"), {
    reason: "ran_recently",
    status: "skipped",
  });
});

test("a caller with the secret is not rationed, and gets the summary", async () => {
  const first = await run("authorized");
  const second = await run("authorized");

  assert.equal(first.status, "ran");
  assert.equal(second.status, "ran");

  if (second.status === "ran") {
    assert.deepEqual(second.summary.accountPurgeFailures, []);
    assert.deepEqual(second.summary.draftDeletionFailures, []);
  }
});

test("a run clears finished rate limit windows", async () => {
  await database.query(
    `insert into public.rate_limits (key, count, expires_at)
     values ('dbtest-finished-window', 3, 1)
     on conflict (key) do nothing`,
  );

  assert.equal((await run("authorized")).status, "ran");

  const leftover = await database.query(
    "select 1 from public.rate_limits where key = 'dbtest-finished-window'",
  );

  assert.equal(leftover.rowCount, 0);
});

test("while one run holds the lock, another steps aside", async () => {
  const holder = await database.connect();

  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock($1)", [
      RETENTION_ADVISORY_LOCK_ID,
    ]);

    assert.deepEqual(await run("authorized"), {
      reason: "already_running",
      status: "skipped",
    });
  } finally {
    await holder.query("rollback");
    holder.release();
  }

  // The lock went with the holder's transaction, and a skipped run leaves
  // none of its own behind.
  assert.equal((await run("authorized")).status, "ran");
});
