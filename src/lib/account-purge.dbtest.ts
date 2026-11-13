import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { afterStatement, openTestDatabase } from "./db/test-database.ts";
import { runRetentionSweep } from "./retention.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";

// Deleting a closed account against a real Postgres, timed against a signer
// who finishes one of its envelopes at that moment. A signed record is the
// organization's: it is handed to an administrator, never deleted with the
// account. Run with `npm run test:db`.

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-purge-"));
  storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(role: "admin" | "user" = "user") {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, $4, true)
    `,
    [id, `Person ${id.slice(0, 4)}`, `${id}@example.test`, role],
  );

  return id;
}

/** An envelope of this account that is out for signature, with its document. */
async function createSentEnvelope(userId: string) {
  const id = randomUUID();
  const sourcePdfKey = `test/${id}.pdf`;

  await storageService.putObject({
    body: new Uint8Array([37, 80, 68, 70]),
    contentType: "application/pdf",
    key: sourcePdfKey,
  });
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at
      ) values ($1, $2, 'Lease', 'sent', $3, 'lease.pdf', 4, 1, $4, 1)
    `,
    [id, userId, sourcePdfKey, "a".repeat(64)],
  );

  return { id, sourcePdfKey };
}

/** Asks for the account to be closed, with its notice already over. */
async function closeAccount(userId: string) {
  await database.query(
    `
      insert into account_closure_requests
        (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
      values ($1, 1, 1, 1, 1)
    `,
    [userId],
  );
}

/** What the last signer's signature does to the envelope. */
function complete(envelopeId: string) {
  return database.query(
    `
      update envelopes
      set status = 'completed', completed_at = 2
      where id = $1 and status = 'sent'
    `,
    [envelopeId],
  );
}

/** Resolves once another session is held up behind a lock. */
async function waitForLockWaiter() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await database.query(
      `
        select 1
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
        limit 1
      `,
    );

    if (result.rowCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function envelopeRow(envelopeId: string) {
  const result = await database.query<{
    handed_over_at: number | null;
    status: string;
    user_id: string;
  }>(`select user_id, status, handed_over_at from envelopes where id = $1`, [
    envelopeId,
  ]);

  return result.rows[0] ?? null;
}

async function accountExists(userId: string) {
  const result = await database.query(
    `select 1 from public."user" where id = $1`,
    [userId],
  );

  return result.rowCount === 1;
}

test("an envelope completed while its sender's account is being deleted goes to an administrator", async () => {
  await createUser("admin");

  const leaver = await createUser();
  const envelope = await createSentEnvelope(leaver);

  await closeAccount(leaver);

  // The last signature lands just after the deletion has taken hold of the
  // account.
  const summary = await runRetentionSweep({
    database: afterStatement(
      database,
      (text, values) =>
        text.includes(`FROM "user" WHERE id = $1 FOR UPDATE`) &&
        values[0] === leaver,
      async () => {
        assert.equal((await complete(envelope.id)).rowCount, 1);
      },
    ),
    storageService,
  });

  assert.ok(!summary.accountPurgeFailures.includes(leaver));
  assert.equal(await accountExists(leaver), false);

  // The signed record outlives the account, with its document.
  const kept = await envelopeRow(envelope.id);

  assert.ok(kept, "the completed envelope was deleted with the account");
  assert.equal(kept.status, "completed");
  assert.notEqual(kept.user_id, leaver);
  assert.ok(kept.handed_over_at);
  assert.equal(
    (await storageService.headObject(envelope.sourcePdfKey)).exists,
    true,
  );
});

test("once the finished envelopes are handed over, no other envelope of the account can be completed", async () => {
  await createUser("admin");

  const leaver = await createUser();
  const envelope = await createSentEnvelope(leaver);
  let signature: Promise<pg.QueryResult> | undefined;

  await closeAccount(leaver);

  // The last signature arrives right after the deletion has looked for
  // finished envelopes and found none. It has to wait for the deletion.
  const summary = await runRetentionSweep({
    database: afterStatement(
      database,
      (text, values) =>
        text.includes("SELECT count(*)::text AS count") &&
        text.includes("FROM envelopes") &&
        values[0] === leaver,
      async () => {
        signature = complete(envelope.id);
        await Promise.race([
          signature.then(
            () => undefined,
            () => undefined,
          ),
          waitForLockWaiter(),
        ]);
      },
    ),
    storageService,
  });

  assert.ok(signature, "the deletion never looked for finished envelopes");
  assert.ok(!summary.accountPurgeFailures.includes(leaver));
  assert.equal(await accountExists(leaver), false);

  // It found no envelope left to complete. Had it completed one, that
  // record would have to be here still.
  const completed = (await signature).rowCount === 1;

  assert.equal(completed, false);
  assert.equal(await envelopeRow(envelope.id), null);
  assert.equal(
    (await storageService.headObject(envelope.sourcePdfKey)).exists,
    false,
  );
});

test("with no administrator to take it, an envelope completed during the deletion keeps its account", async () => {
  // No administrator is left for the length of this test.
  const administrators = await database.query<{ id: string }>(
    `update public."user" set role = 'user' where role = 'admin' returning id`,
  );

  try {
    const leaver = await createUser();
    const envelope = await createSentEnvelope(leaver);

    await closeAccount(leaver);

    const summary = await runRetentionSweep({
      database: afterStatement(
        database,
        (text, values) =>
          text.includes(`FROM "user" WHERE id = $1 FOR UPDATE`) &&
          values[0] === leaver,
        async () => {
          assert.equal((await complete(envelope.id)).rowCount, 1);
        },
      ),
      storageService,
    });

    // Nothing is deleted. The next run tries again.
    assert.ok(summary.accountPurgeFailures.includes(leaver));
    assert.equal(await accountExists(leaver), true);
    assert.deepEqual(await envelopeRow(envelope.id), {
      handed_over_at: null,
      status: "completed",
      user_id: leaver,
    });
    assert.equal(
      (await storageService.headObject(envelope.sourcePdfKey)).exists,
      true,
    );
  } finally {
    await database.query(
      `update public."user" set role = 'admin' where id = any($1)`,
      [administrators.rows.map((row) => row.id)],
    );
  }
});
