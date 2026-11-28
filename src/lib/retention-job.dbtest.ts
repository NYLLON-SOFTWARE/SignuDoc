import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  RETENTION_ADVISORY_LOCK_ID,
  retentionJobFailed,
  runRetentionJob,
} from "./retention-job.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  buildEnvelopeOriginalPdfKey,
  buildEnvelopeThumbnailKey,
  buildTemplatePdfKey,
} from "./services/storage-keys.ts";

// The cleanup job's hourly ration, its lock, and durable file-deletion
// retries for closed accounts and stale drafts, against a real Postgres.
// Run with `npm run test:db`.

const RATION_KEY = createHash("sha256").update("job:retention").digest("hex");

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];
const createdPendingKeys: string[] = [];

function run(
  caller: "anonymous" | "authorized",
  customStorage: StorageService = storageService,
) {
  return runRetentionJob({
    caller,
    database,
    storageService: customStorage,
  });
}

function createFailingStorage(base: StorageService): StorageService {
  return {
    ...base,
    deleteObject: async () => {
      throw new Error("Storage is unavailable.");
    },
  };
}

async function createUser() {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, 'user', true)
    `,
    [id, `Person ${id.slice(0, 4)}`, `${id}@example.test`],
  );

  return id;
}

async function createDraftWithPdf(userId: string, updatedAt: number) {
  const id = randomUUID();
  const sourcePdfKey = buildEnvelopeOriginalPdfKey({ envelopeId: id, userId });
  const thumbnailKey = buildEnvelopeThumbnailKey({
    envelopeId: id,
    sourcePdfKey,
    userId,
  });

  createdPendingKeys.push(sourcePdfKey, thumbnailKey);
  await storageService.putObject({
    body: new Uint8Array([37, 80, 68, 70]),
    contentType: "application/pdf",
    key: sourcePdfKey,
  });
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, created_at, updated_at
      ) values ($1, $2, 'Draft', 'draft', $3, 'draft.pdf', 4, 1, $4, $5, $5)
    `,
    [id, userId, sourcePdfKey, "a".repeat(64), updatedAt],
  );

  return { id, sourcePdfKey, thumbnailKey };
}

async function createTemplateWithPdf(userId: string) {
  const id = randomUUID();
  const sourcePdfKey = buildTemplatePdfKey({ templateId: id, userId });

  createdPendingKeys.push(sourcePdfKey);
  await storageService.putObject({
    body: new Uint8Array([37, 80, 68, 70]),
    contentType: "application/pdf",
    key: sourcePdfKey,
  });
  await database.query(
    `
      insert into templates (
        id, user_id, name, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, roles, fields
      ) values ($1, $2, 'Template', $3, 'template.pdf', 4, 1, $4::jsonb, '[]'::jsonb)
    `,
    [id, userId, sourcePdfKey, JSON.stringify([{ id: "r1", name: "Signer" }])],
  );

  return { id, sourcePdfKey };
}

async function closeAccountDue(userId: string) {
  await database.query(
    `
      insert into account_closure_requests
        (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
      values ($1, 1, 1, 1, 1)
    `,
    [userId],
  );
}

async function pendingRowsForKeys(keys: readonly string[]) {
  const result = await database.query<{ storage_key: string }>(
    `select storage_key from pending_file_deletions where storage_key = any($1)`,
    [keys],
  );

  return result.rows.map((row) => row.storage_key);
}

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  const originalInfo = console.info;

  console.error = () => {};
  console.info = () => {};

  try {
    return await work();
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }
}

async function clearRation() {
  await database.query("delete from public.rate_limits where key = $1", [
    RATION_KEY,
  ]);
}

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-retention-"));
  storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });
});

after(async () => {
  await clearRation();
  await database.query(
    `delete from pending_file_deletions where storage_key = any($1)`,
    [createdPendingKeys],
  );
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
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
    assert.deepEqual(second.summary.pendingFileDeletionFailures, []);
  }
});

test("Drive failures mark a run as failed and a deferred batch can finish normally", async () => {
  const outcome = await run("authorized");
  assert.equal(outcome.status, "ran");
  assert.equal(retentionJobFailed(outcome), false);
  assert.equal(
    retentionJobFailed({
      ...outcome,
      driveFiling: { failures: 1, filed: 0, stoppedEarly: false },
    }),
    true,
  );
  assert.equal(
    retentionJobFailed({
      ...outcome,
      driveFiling: { failures: 0, filed: 1, stoppedEarly: true },
    }),
    false,
  );
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

test("a closed-account purge with working storage deletes its files on the first run", async () => {
  const now = Math.floor(Date.now() / 1000);
  const userId = await createUser();
  const draft = await createDraftWithPdf(userId, now);
  const template = await createTemplateWithPdf(userId);

  await closeAccountDue(userId);

  const outcome = await quietly(() => run("authorized"));

  assert.equal(outcome.status, "ran");

  if (outcome.status === "ran") {
    assert.ok(outcome.summary.accountsPurged >= 1);
    assert.ok(!outcome.summary.accountPurgeFailures.includes(userId));
    assert.equal(retentionJobFailed(outcome), false);
  }

  assert.equal(
    (await storageService.headObject(draft.sourcePdfKey)).exists,
    false,
  );
  assert.equal(
    (await storageService.headObject(template.sourcePdfKey)).exists,
    false,
  );
  assert.deepEqual(
    await pendingRowsForKeys([
      draft.sourcePdfKey,
      draft.thumbnailKey,
      template.sourcePdfKey,
    ]),
    [],
  );
});

test("a closed-account purge whose files cannot be deleted reports failure and retries after storage recovers", async () => {
  const now = Math.floor(Date.now() / 1000);
  const userId = await createUser();
  const draft = await createDraftWithPdf(userId, now);
  const template = await createTemplateWithPdf(userId);
  const keys = [draft.sourcePdfKey, draft.thumbnailKey, template.sourcePdfKey];

  await closeAccountDue(userId);

  const first = await quietly(() =>
    run("authorized", createFailingStorage(storageService)),
  );

  assert.equal(first.status, "ran");

  if (first.status === "ran") {
    assert.ok(first.summary.accountsPurged >= 1);
    assert.ok(first.summary.accountPurgeFailures.includes(userId));
    assert.equal(retentionJobFailed(first), true);
  }

  assert.equal(
    (
      await database.query(`select 1 from public."user" where id = $1`, [
        userId,
      ])
    ).rowCount,
    0,
  );
  assert.deepEqual((await pendingRowsForKeys(keys)).sort(), [...keys].sort());
  assert.equal(
    (await storageService.headObject(draft.sourcePdfKey)).exists,
    true,
  );
  assert.equal(
    (await storageService.headObject(template.sourcePdfKey)).exists,
    true,
  );

  // While storage is still down, retrying queued deletions still fails the run.
  const stillDown = await quietly(() =>
    run("authorized", createFailingStorage(storageService)),
  );

  assert.equal(stillDown.status, "ran");

  if (stillDown.status === "ran") {
    assert.ok(
      stillDown.summary.pendingFileDeletionFailures.includes(
        draft.sourcePdfKey,
      ),
    );
    assert.ok(
      stillDown.summary.pendingFileDeletionFailures.includes(
        template.sourcePdfKey,
      ),
    );
    assert.equal(retentionJobFailed(stillDown), true);
  }

  // Storage recovers: the next daily run retries and removes both files.
  const next = await quietly(() => run("authorized", storageService));

  assert.equal(next.status, "ran");

  if (next.status === "ran") {
    assert.ok(next.summary.pendingFileDeletionsDone >= keys.length);
    assert.equal(retentionJobFailed(next), false);
  }

  assert.equal(
    (await storageService.headObject(draft.sourcePdfKey)).exists,
    false,
  );
  assert.equal(
    (await storageService.headObject(template.sourcePdfKey)).exists,
    false,
  );
  assert.deepEqual(await pendingRowsForKeys(keys), []);
});

test("a stale-draft purge with working storage deletes its file on the first run", async () => {
  const userId = await createUser();
  const draft = await createDraftWithPdf(userId, 1);

  const outcome = await quietly(() => run("authorized"));

  assert.equal(outcome.status, "ran");

  if (outcome.status === "ran") {
    assert.ok(outcome.summary.draftsDeleted >= 1);
    assert.ok(!outcome.summary.draftDeletionFailures.includes(draft.id));
    assert.equal(retentionJobFailed(outcome), false);
  }

  assert.equal(
    (await storageService.headObject(draft.sourcePdfKey)).exists,
    false,
  );
  assert.deepEqual(
    await pendingRowsForKeys([draft.sourcePdfKey, draft.thumbnailKey]),
    [],
  );
});

test("a stale-draft purge whose files cannot be deleted stays queued and retries after storage recovers", async () => {
  const userId = await createUser();
  const draft = await createDraftWithPdf(userId, 1);
  const keys = [draft.sourcePdfKey, draft.thumbnailKey];

  const first = await quietly(() =>
    run("authorized", createFailingStorage(storageService)),
  );

  assert.equal(first.status, "ran");

  if (first.status === "ran") {
    assert.ok(first.summary.draftsDeleted >= 1);
    assert.ok(first.summary.draftDeletionFailures.includes(draft.id));
    assert.equal(retentionJobFailed(first), true);
  }

  assert.equal(
    (await database.query(`select 1 from envelopes where id = $1`, [draft.id]))
      .rowCount,
    0,
  );
  assert.deepEqual((await pendingRowsForKeys(keys)).sort(), [...keys].sort());
  assert.equal(
    (await storageService.headObject(draft.sourcePdfKey)).exists,
    true,
  );

  // While storage is still down, retrying queued deletions still fails the run.
  const stillDown = await quietly(() =>
    run("authorized", createFailingStorage(storageService)),
  );

  assert.equal(stillDown.status, "ran");

  if (stillDown.status === "ran") {
    assert.ok(
      stillDown.summary.pendingFileDeletionFailures.includes(
        draft.sourcePdfKey,
      ),
    );
    assert.equal(retentionJobFailed(stillDown), true);
  }

  // Storage recovers: the next daily run retries and removes the file.
  const next = await quietly(() => run("authorized", storageService));

  assert.equal(next.status, "ran");

  if (next.status === "ran") {
    assert.ok(next.summary.pendingFileDeletionsDone >= keys.length);
    assert.equal(retentionJobFailed(next), false);
  }

  assert.equal(
    (await storageService.headObject(draft.sourcePdfKey)).exists,
    false,
  );
  assert.deepEqual(await pendingRowsForKeys(keys), []);
});
