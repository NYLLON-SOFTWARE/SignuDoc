import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { runRetentionSweep } from "./retention.ts";
import { recordAuditEvent, verifyAuditChain } from "./services/audit.ts";
import type { EmailService } from "./services/email.ts";
import { createStorageService } from "./services/storage.ts";
import { eraseSignerData, exportSignerData } from "./signer-data.ts";

// The audit hash chain, signer data requests, account hand-over and the
// retention period, against a real Postgres. Run with `npm run test:db`.

let database: pg.Pool;
let storageDir: string;
const createdUsers: string[] = [];
let settingsRowExisted = true;

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-evidence-"));
  settingsRowExisted =
    (await database.query(`select 1 from app_settings`)).rowCount === 1;
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.query(
    settingsRowExisted
      ? `update app_settings set retention_days = null`
      : `delete from app_settings`,
  );
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

function storage() {
  return createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });
}

async function createUser(role: "admin" | "user" = "user") {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, $2, $3, $4)`,
    [id, `User ${id.slice(0, 4)}`, `${id}@example.test`, role],
  );

  return id;
}

async function createEnvelope(
  userId: string,
  status: "completed" | "draft" | "sent",
  signerEmail: string,
  finishedAt: number | null = null,
) {
  const id = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, completed_at
      ) values ($1, $2, 'Test', $3, $4, 'test.pdf', 10, 1, $5, $6)
    `,
    [id, userId, status, `test/${id}.pdf`, "a".repeat(64), finishedAt],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Signer', $3, 1, 'pending')
    `,
    [randomUUID(), id, signerEmail],
  );

  return id;
}

async function envelopeOwner(envelopeId: string) {
  const result = await database.query<{ user_id: string }>(
    `select user_id from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.user_id ?? null;
}

test("the audit chain verifies, and shows an edited row", async () => {
  const owner = await createUser();
  const envelopeId = await createEnvelope(owner, "sent", "a@example.test");

  for (const event of ["created", "sent", "viewed"] as const) {
    await recordAuditEvent(
      { actorType: "system", envelopeId, event, metadata: { n: event } },
      database,
    );
  }

  assert.deepEqual(await verifyAuditChain(envelopeId, database), {
    chainedEvents: 3,
    ok: true,
  });

  await database.query(
    `update audit_events set ip_address = '10.0.0.1' where envelope_id = $1 and event = 'sent'`,
    [envelopeId],
  );

  const check = await verifyAuditChain(envelopeId, database);

  assert.equal(check.ok, false);
  assert.equal(check.ok ? null : check.brokenAtSequence, 2);
});

test("a signer's data can be exported, then erased from finished envelopes only", async () => {
  const owner = await createUser();
  const email = `${randomUUID()}@example.test`;
  const finished = await createEnvelope(owner, "completed", email, 1);
  const inFlight = await createEnvelope(owner, "sent", email);
  const draft = await createEnvelope(owner, "draft", email);

  const exported = await exportSignerData(email.toUpperCase(), database);

  assert.equal(exported.envelopes.length, 3);

  await assert.rejects(eraseSignerData(email, "someone@else.test", database));

  const result = await eraseSignerData(email, email, database);

  assert.equal(result.deletedEnvelopes, 1);
  assert.equal(result.removedFromDrafts, 1);
  assert.deepEqual(
    result.skippedInProgress.map((row) => row.id),
    [inFlight],
  );
  assert.equal(await envelopeOwner(finished), null);
  assert.equal(await envelopeOwner(draft), owner);
  assert.equal((await exportSignerData(email, database)).envelopes.length, 1);
});

test("closing an account hands finished envelopes to an administrator", async () => {
  const admin = await createUser("admin");
  const leaver = await createUser();
  const finished = await createEnvelope(
    leaver,
    "completed",
    "x@example.test",
    1,
  );
  const draft = await createEnvelope(leaver, "draft", "x@example.test");

  await database.query(
    `
      insert into account_closure_requests
        (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
      values ($1, 1, 1, 1, 1)
    `,
    [leaver],
  );

  const summary = await runRetentionSweep({
    database,
    storageService: storage(),
  });

  assert.ok(!summary.accountPurgeFailures.includes(leaver));
  assert.equal(await envelopeOwner(finished), admin);
  assert.equal(await envelopeOwner(draft), null);
});

test("the retention period warns the sender, then deletes", async () => {
  const owner = await createUser();
  const now = 2_000_000_000;
  const day = 24 * 60 * 60;
  const old = await createEnvelope(
    owner,
    "completed",
    "r@example.test",
    now - 400 * day,
  );
  const recent = await createEnvelope(
    owner,
    "completed",
    "r@example.test",
    now - 10 * day,
  );
  const sent: string[] = [];
  const emailService = {
    send: async (message: { subject: string; to: string }) => {
      sent.push(message.to);

      return { accepted: [message.to], rejected: [] };
    },
    sendBatch: async () => ({ accepted: [], rejected: [] }),
  } as unknown as EmailService;

  await database.query(
    `insert into app_settings (id, signup_mode, retention_days, created_at, updated_at)
     values (true, 'closed', 365, 1, 1)
     on conflict (id) do update set retention_days = 365`,
  );

  const first = await runRetentionSweep({
    database,
    emailService,
    now,
    storageService: storage(),
  });

  assert.ok(first.finishedEnvelopeWarningsSent >= 1);
  assert.ok(sent.includes(`${owner}@example.test`));
  assert.equal(await envelopeOwner(old), owner);

  const later = await runRetentionSweep({
    database,
    emailService,
    now: now + 8 * day,
    storageService: storage(),
  });

  assert.ok(later.finishedEnvelopesDeleted >= 1);
  assert.equal(await envelopeOwner(old), null);
  assert.equal(await envelopeOwner(recent), owner);
});
