import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";

import type pg from "pg";

import { isSqliteUrl } from "./db/sqlite/pool.ts";
import {
  afterStatement,
  besideOpenTransactions,
  openTestDatabase,
} from "./db/test-database.ts";
import {
  cancelEnvelopeDeletion,
  deleteScheduledEnvelope,
  ENVELOPE_DELETION_WAIT_DAYS,
  getScheduledEnvelopeDeletion,
  runScheduledEnvelopeDeletions,
  SCHEDULED_DELETIONS_PER_RUN,
  scheduleEnvelopeDeletion,
} from "./envelope-deletion.ts";
import { EnvelopeMutationError } from "./envelopes.ts";
import {
  deletePendingFiles,
  queueFileDeletions,
  runRetentionSweep,
} from "./retention.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { getRecipientCertificateKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  listSystemAuditEvents,
  verifySystemAuditChain,
} from "./services/system-audit.ts";

// An administrator scheduling a finished envelope's deletion, cancelling
// it, and the daily cleanup deleting it once the wait is over, against a
// real Postgres. Run with `npm run test:db`.

const SOURCE_HASH = "a".repeat(64);
const SIGNED_HASH = "b".repeat(64);
const EVIDENCE_HASH = "c".repeat(64);
const RECIPIENT_EVIDENCE_HASH = "d".repeat(64);
// The install audit trail's lock (services/system-audit.ts).
const SYSTEM_AUDIT_LOCK_ID = 746108325;
const DAY = 24 * 60 * 60;
const WAIT = ENVELOPE_DELETION_WAIT_DAYS * DAY;

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-deletion-"));
  Object.assign(process.env, {
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(role: "admin" | "user") {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Avery Admin', $2, $3)`,
    [id, email, role],
  );

  return { email, userId: id };
}

/** An envelope with its files stored, in the given state. */
async function createEnvelope(
  userId: string,
  {
    part11 = false,
    status,
  }: {
    part11?: boolean;
    status: "completed" | "declined" | "draft" | "sent" | "voided";
  },
) {
  const envelopeId = randomUUID();
  const base = `users/${userId}/envelopes/${envelopeId}`;
  const keys = {
    evidence: `${base}/evidence/internal.pdf`,
    signed: `${base}/signed.pdf`,
    source: `${base}/source.pdf`,
  };
  const finished = status !== "draft" && status !== "sent";
  const stored = [keys.source];

  if (finished) {
    stored.push(
      keys.evidence,
      getRecipientCertificateKey(keys.evidence),
      ...(status === "completed" ? [keys.signed] : []),
    );
  }

  for (const key of stored) {
    await storageService.putObject({
      body: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
      key,
    });
  }

  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        completed_at, declined_at, voided_at, signed_pdf_key, evidence_key,
        signed_pdf_sha256, evidence_sha256, part11, recipient_evidence_sha256
      ) values (
        $1, $2, 'Lease', $3, $4, 'lease.pdf', 4, 1, $14, $5,
        $6, $7, $8, $9, $10, $11, $12, $13, $15
      )
    `,
    [
      envelopeId,
      userId,
      status,
      keys.source,
      status === "draft" ? null : now - 100,
      status === "completed" ? now : null,
      status === "declined" ? now : null,
      status === "voided" ? now : null,
      status === "completed" ? keys.signed : null,
      finished ? keys.evidence : null,
      status === "completed" ? SIGNED_HASH : null,
      finished ? EVIDENCE_HASH : null,
      part11,
      SOURCE_HASH,
      finished ? RECIPIENT_EVIDENCE_HASH : null,
    ],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Riley Recipient', 'riley@example.test', 1, $3)
    `,
    [randomUUID(), envelopeId, status === "completed" ? "signed" : "pending"],
  );

  return { envelopeId, stored };
}

async function envelopeExists(envelopeId: string) {
  const result = await database.query(`select 1 from envelopes where id = $1`, [
    envelopeId,
  ]);

  return result.rowCount === 1;
}

async function pendingFileDeletions(envelopeId: string) {
  const result = await database.query<{ storage_key: string }>(
    `select storage_key from pending_file_deletions where envelope_id = $1`,
    [envelopeId],
  );

  return result.rows.map((row) => row.storage_key);
}

async function filesExist(keys: readonly string[]) {
  return Promise.all(
    keys.map(async (key) => (await storageService.headObject(key)).exists),
  );
}

let sent: TransactionalEmailMessage[] = [];

function createOutbox(fail = false): EmailService {
  return {
    async send(message) {
      if (fail) {
        throw new Error("Email is down.");
      }

      sent.push(message);
      return { accepted: [message.to], rejected: [] };
    },
    async sendBatch(messages) {
      return Promise.all(messages.map((message) => this.send(message)));
    },
  };
}

function emailsTo(address: string) {
  return sent.filter((message) => message.to === address);
}

function scheduleAs(
  actor: { email: string; userId: string },
  envelopeId: string,
  reason?: unknown,
  { emailService = createOutbox(), now = Math.floor(Date.now() / 1000) } = {},
) {
  return scheduleEnvelopeDeletion(
    envelopeId,
    { actor, ipAddress: "203.0.113.9", reason, userAgent: "Test browser" },
    { database, emailService, now },
  );
}

function cancelAs(
  actor: { email: string; userId: string },
  envelopeId: string,
  { emailService = createOutbox(), now = Math.floor(Date.now() / 1000) } = {},
) {
  return cancelEnvelopeDeletion(
    envelopeId,
    { actor, ipAddress: "203.0.113.9", userAgent: "Test browser" },
    { database, emailService, now },
  );
}

function runDaily(now: number, emailService = createOutbox()) {
  return runScheduledEnvelopeDeletions({
    database,
    emailService,
    now,
    storageService,
  });
}

function quietly<T>(work: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error;

  console.error = () => {};

  return work().finally(() => {
    console.error = originalConsoleError;
  });
}

function deleteWhenDue(
  envelopeId: string,
  now: number,
  storage: StorageService = storageService,
) {
  return deleteScheduledEnvelope(envelopeId, {
    database,
    now,
    storageService: storage,
  });
}

function rejectsWith(statusCode: number) {
  return (error: unknown) =>
    error instanceof EnvelopeMutationError && error.statusCode === statusCode;
}

async function latestEvent() {
  const [event] = await listSystemAuditEvents({ limit: 1 }, database);

  return event;
}

for (const status of ["completed", "declined", "voided"] as const) {
  test(`a ${status} envelope is scheduled, waits ${String(ENVELOPE_DELETION_WAIT_DAYS)} days, then goes with its files, all on record`, async () => {
    const admin = await createUser("admin");
    const envelope = await createEnvelope(admin.userId, { status });
    const now = Math.floor(Date.now() / 1000);

    const scheduled = await scheduleAs(
      admin,
      envelope.envelopeId,
      "Kept long enough.",
      { now },
    );

    assert.equal(scheduled.deleteAfter, now + WAIT);
    // Nothing goes yet.
    assert.equal(await envelopeExists(envelope.envelopeId), true);
    assert.ok((await filesExist(envelope.stored)).every(Boolean));

    const request = await latestEvent();

    assert.equal(request?.event, "envelope_deletion_scheduled");
    assert.equal(request?.actorUserId, admin.userId);
    assert.equal(request?.ipAddress, "203.0.113.9");
    assert.equal(request?.metadata?.deleteAfter, now + WAIT);
    assert.equal(request?.metadata?.reason, "Kept long enough.");

    // A day early, still nothing.
    assert.equal(
      await deleteWhenDue(envelope.envelopeId, now + WAIT - DAY),
      false,
    );
    assert.equal(await envelopeExists(envelope.envelopeId), true);

    assert.equal(await deleteWhenDue(envelope.envelopeId, now + WAIT), true);
    assert.equal(await envelopeExists(envelope.envelopeId), false);
    assert.equal(
      await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
      null,
    );
    assert.deepEqual(
      await filesExist(envelope.stored),
      envelope.stored.map(() => false),
    );
    assert.deepEqual(await pendingFileDeletions(envelope.envelopeId), []);

    const event = await latestEvent();

    assert.equal(event?.event, "envelope_deleted");
    // Under the administrator who asked for it.
    assert.equal(event?.actorUserId, admin.userId);
    assert.equal(event?.actorEmail, admin.email);
    assert.deepEqual(
      {
        envelopeId: event?.metadata?.envelopeId,
        evidenceSha256: event?.metadata?.evidenceSha256,
        reason: event?.metadata?.reason,
        recipientEvidenceSha256: event?.metadata?.recipientEvidenceSha256,
        requestedAt: event?.metadata?.requestedAt,
        sourcePdfHash: event?.metadata?.sourcePdfHash,
        status: event?.metadata?.status,
        title: event?.metadata?.title,
      },
      {
        envelopeId: envelope.envelopeId,
        evidenceSha256: EVIDENCE_HASH,
        reason: "Kept long enough.",
        recipientEvidenceSha256: RECIPIENT_EVIDENCE_HASH,
        requestedAt: now,
        sourcePdfHash: SOURCE_HASH,
        status,
        title: "Lease",
      },
    );
    assert.equal((await verifySystemAuditChain(database)).ok, true);
  });
}

test("someone who is not an administrator cannot schedule a deletion", async () => {
  const user = await createUser("user");
  const envelope = await createEnvelope(user.userId, { status: "completed" });
  const before = await listSystemAuditEvents({ limit: 1 }, database);

  await assert.rejects(scheduleAs(user, envelope.envelopeId), rejectsWith(403));

  assert.equal(
    await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
    null,
  );
  assert.deepEqual(await listSystemAuditEvents({ limit: 1 }, database), before);
});

test("an envelope still out for signature, or a draft, is not scheduled", async () => {
  const admin = await createUser("admin");

  for (const status of ["sent", "draft"] as const) {
    const envelope = await createEnvelope(admin.userId, { status });

    await assert.rejects(
      scheduleAs(admin, envelope.envelopeId),
      rejectsWith(409),
    );
    assert.equal(
      await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
      null,
    );
  }
});

test("another member's envelope: its sender is emailed, and the records name them", async () => {
  sent = [];
  const owner = await createUser("user");
  const admin = await createUser("admin");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);

  await scheduleAs(admin, envelope.envelopeId, "Asked to by legal.", { now });

  const [notice] = emailsTo(owner.email);

  assert.equal(notice?.template, "deletion_notice");
  assert.match(
    notice?.subject ?? "",
    /^"Lease" will be deleted on \d{4}-\d{2}-\d{2}$/,
  );
  assert.ok(notice?.textBody.includes(admin.email));
  // The reason is for administrators.
  assert.doesNotMatch(notice?.textBody ?? "", /legal/);

  const request = await latestEvent();

  assert.equal(request?.targetUserId, owner.userId);
  assert.equal(request?.metadata?.ownerEmail, owner.email);

  await deleteWhenDue(envelope.envelopeId, now + WAIT);

  const event = await latestEvent();

  assert.equal(event?.event, "envelope_deleted");
  assert.equal(event?.actorUserId, admin.userId);
  assert.equal(event?.metadata?.ownerUserId, owner.userId);
  assert.equal(event?.metadata?.ownerEmail, owner.email);
  assert.equal(event?.metadata?.reason, "Asked to by legal.");
  assert.equal(typeof event?.metadata?.senderNotifiedAt, "number");
});

test("an administrator's own envelope sends no email", async () => {
  sent = [];
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });

  await scheduleAs(admin, envelope.envelopeId);

  assert.deepEqual(emailsTo(admin.email), []);
});

test("someone who is not an administrator cannot find another member's envelope", async () => {
  const owner = await createUser("admin");
  const other = await createUser("user");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });

  await assert.rejects(
    scheduleAs(other, envelope.envelopeId),
    rejectsWith(404),
  );
  await assert.rejects(cancelAs(other, envelope.envelopeId), rejectsWith(404));
  await assert.rejects(scheduleAs(owner, randomUUID()), rejectsWith(404));
});

test("a deletion already scheduled is not scheduled twice", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });

  await scheduleAs(admin, envelope.envelopeId);
  await assert.rejects(
    scheduleAs(admin, envelope.envelopeId),
    rejectsWith(409),
  );
});

test("any administrator can cancel, the sender is told, and nothing is deleted", async () => {
  sent = [];
  const owner = await createUser("user");
  const admin = await createUser("admin");
  const otherAdmin = await createUser("admin");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);

  await scheduleAs(admin, envelope.envelopeId, "Tidying up.", { now });
  await cancelAs(otherAdmin, envelope.envelopeId);

  assert.equal(
    await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
    null,
  );

  const event = await latestEvent();

  assert.equal(event?.event, "envelope_deletion_cancelled");
  assert.equal(event?.actorUserId, otherAdmin.userId);
  assert.equal(event?.metadata?.requestedByEmail, admin.email);
  assert.deepEqual(
    emailsTo(owner.email).map((message) => message.subject),
    [
      '"Lease" will be deleted on ' +
        new Date((now + WAIT) * 1000).toISOString().slice(0, 10),
      '"Lease" will not be deleted',
    ],
  );

  // The day it would have gone, it stays.
  assert.equal(await deleteWhenDue(envelope.envelopeId, now + WAIT), false);
  assert.equal(await envelopeExists(envelope.envelopeId), true);
  assert.ok((await filesExist(envelope.stored)).every(Boolean));

  // Nothing left to cancel; a member cannot cancel at all.
  await assert.rejects(cancelAs(admin, envelope.envelopeId), rejectsWith(409));
  await assert.rejects(cancelAs(owner, envelope.envelopeId), rejectsWith(403));
  await assert.rejects(
    scheduleAs(owner, envelope.envelopeId),
    rejectsWith(403),
  );
});

test("a Part 11 record needs a reason before it is scheduled", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, {
    part11: true,
    status: "completed",
  });
  const now = Math.floor(Date.now() / 1000);

  await assert.rejects(
    scheduleAs(admin, envelope.envelopeId, "   "),
    rejectsWith(400),
  );
  assert.equal(
    await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
    null,
  );

  await scheduleAs(admin, envelope.envelopeId, "Retention period over.", {
    now,
  });
  await deleteWhenDue(envelope.envelopeId, now + WAIT);

  assert.equal(await envelopeExists(envelope.envelopeId), false);

  const event = await latestEvent();

  assert.equal(event?.metadata?.part11, true);
  assert.equal(event?.metadata?.reason, "Retention period over.");
});

test("a reason that is not text, or too long, is refused", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "voided" });

  await assert.rejects(
    scheduleAs(admin, envelope.envelopeId, 42),
    rejectsWith(400),
  );
  await assert.rejects(
    scheduleAs(admin, envelope.envelopeId, "x".repeat(1001)),
    rejectsWith(400),
  );
  assert.equal(
    await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
    null,
  );
});

test("nothing is deleted before the sender is told, and a late notice still gives the whole wait", async () => {
  sent = [];
  const owner = await createUser("user");
  const admin = await createUser("admin");
  const envelope = await createEnvelope(owner.userId, { status: "declined" });
  const now = Math.floor(Date.now() / 1000);

  await quietly(() =>
    scheduleAs(admin, envelope.envelopeId, undefined, {
      emailService: createOutbox(true),
      now,
    }),
  );

  assert.ok(await getScheduledEnvelopeDeletion(envelope.envelopeId, database));
  assert.deepEqual(emailsTo(owner.email), []);

  // Past the date, but the sender was never told: it stays.
  const unsent = await quietly(() => runDaily(now + WAIT, createOutbox(true)));

  assert.ok(unsent.noticeFailures.includes(envelope.envelopeId));
  assert.equal(await envelopeExists(envelope.envelopeId), true);
  assert.equal(await deleteWhenDue(envelope.envelopeId, now + WAIT), false);

  // Email is back a day later: the notice goes, with a date a whole wait
  // from then.
  const toldAt = now + WAIT + DAY;
  const summary = await runDaily(toldAt);

  assert.ok(summary.noticesSent >= 1);
  assert.deepEqual(
    emailsTo(owner.email).map((message) => message.subject),
    [
      `"Lease" will be deleted on ${new Date((toldAt + WAIT) * 1000).toISOString().slice(0, 10)}`,
    ],
  );
  assert.equal(
    (await getScheduledEnvelopeDeletion(envelope.envelopeId, database))
      ?.deleteAfter,
    toldAt + WAIT,
  );

  // Told once: the next run does not send it again, nor delete it early.
  await runDaily(toldAt + DAY);
  assert.equal(emailsTo(owner.email).length, 1);
  assert.equal(await envelopeExists(envelope.envelopeId), true);

  // Once the new wait is over, the run deletes it.
  const final = await runDaily(toldAt + WAIT);

  assert.ok(final.deleted >= 1);
  assert.deepEqual(final.failures, []);
  assert.equal(await envelopeExists(envelope.envelopeId), false);
});

test("a cancellation email that fails is sent by the daily run", async () => {
  sent = [];
  const owner = await createUser("user");
  const admin = await createUser("admin");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);

  await scheduleAs(admin, envelope.envelopeId, undefined, { now });
  await quietly(() =>
    cancelAs(admin, envelope.envelopeId, {
      emailService: createOutbox(true),
      now: now + 60,
    }),
  );

  assert.equal(emailsTo(owner.email).length, 1);

  await runDaily(now + DAY);

  assert.deepEqual(
    emailsTo(owner.email)
      .map((message) => message.subject)
      .slice(1),
    ['"Lease" will not be deleted'],
  );

  // Told once; then the cancelled request is cleared away.
  await runDaily(now + 2 * DAY);
  assert.equal(emailsTo(owner.email).length, 2);

  const left = await database.query(
    `select 1 from scheduled_envelope_deletions where envelope_id = $1`,
    [envelope.envelopeId],
  );

  assert.equal(left.rowCount, 0);
  assert.equal(await envelopeExists(envelope.envelopeId), true);
});

test("a cancellation while the notice is going out still reaches the sender", async () => {
  sent = [];
  const owner = await createUser("user");
  const admin = await createUser("admin");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);
  const outbox = createOutbox();
  // The notice is accepted only after another administrator has cancelled.
  const slowOutbox: EmailService = {
    ...outbox,
    async send(message, options) {
      await cancelAs(admin, envelope.envelopeId, { now: now + 1 });
      return outbox.send(message, options);
    },
  };

  await scheduleAs(admin, envelope.envelopeId, undefined, {
    emailService: slowOutbox,
    now,
  });

  // The cancellation saw no notice yet, so sent nothing; the notice then
  // went out.
  assert.equal(emailsTo(owner.email).length, 1);
  assert.equal(
    await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
    null,
  );

  await runDaily(now + DAY);

  assert.deepEqual(
    emailsTo(owner.email).map((message) => message.subject)[1],
    '"Lease" will not be deleted',
  );
  assert.equal(await deleteWhenDue(envelope.envelopeId, now + 2 * WAIT), false);
  assert.equal(await envelopeExists(envelope.envelopeId), true);
});

test("a cancellation email still owed is not sent once the deletion is scheduled again", async () => {
  sent = [];
  const admin = await createUser("admin");
  const first = { owner: await createUser("user") };
  const second = { owner: await createUser("user") };
  const firstEnvelope = await createEnvelope(first.owner.userId, {
    status: "completed",
  });
  const secondEnvelope = await createEnvelope(second.owner.userId, {
    status: "completed",
  });
  // Long ago, so the daily run reaches these two before anything else.
  const start = 1_000_000_000;

  // The first sender is still owed their notice.
  await quietly(() =>
    scheduleAs(admin, firstEnvelope.envelopeId, undefined, {
      emailService: createOutbox(true),
      now: start,
    }),
  );
  // The second was told, then the cancellation email failed.
  await scheduleAs(admin, secondEnvelope.envelopeId, undefined, {
    now: start + 1,
  });
  await quietly(() =>
    cancelAs(admin, secondEnvelope.envelopeId, {
      emailService: createOutbox(true),
      now: start + 2,
    }),
  );

  // While the daily run sends the first notice, an administrator schedules
  // the second deletion again, and its sender is told so. (On SQLite, with
  // one writer, the reschedule waits for that notice's transaction and goes
  // in before the run's next one.)
  const outbox = createOutbox();
  const beside = besideOpenTransactions();
  let rescheduled = false;
  const reschedulingOutbox: EmailService = {
    ...outbox,
    async send(message, options) {
      if (!rescheduled && message.to === first.owner.email) {
        rescheduled = true;
        await beside.run(() =>
          scheduleAs(admin, secondEnvelope.envelopeId, "Again.", {
            now: start + DAY,
          }),
        );
      }

      return outbox.send(message, options);
    },
  };

  await runDaily(start + DAY, reschedulingOutbox);
  await beside.settled();

  assert.equal(rescheduled, true);
  // The old cancellation never followed the new notice.
  assert.deepEqual(
    emailsTo(second.owner.email).map((message) => message.subject),
    [
      `"Lease" will be deleted on ${new Date((start + 1 + WAIT) * 1000).toISOString().slice(0, 10)}`,
      `"Lease" will be deleted on ${new Date((start + DAY + WAIT) * 1000).toISOString().slice(0, 10)}`,
    ],
  );
  assert.equal(
    (await getScheduledEnvelopeDeletion(secondEnvelope.envelopeId, database))
      ?.reason,
    "Again.",
  );

  // Nor does a later run send it.
  await runDaily(start + 2 * DAY);
  assert.equal(emailsTo(second.owner.email).length, 2);
});

test("a deletion scheduled again while its cancellation email is going out waits, so its own notice comes after", async () => {
  sent = [];
  const admin = await createUser("admin");
  const owner = await createUser("user");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });
  const start = 1_100_000_000;

  await scheduleAs(admin, envelope.envelopeId, undefined, { now: start });
  await quietly(() =>
    cancelAs(admin, envelope.envelopeId, {
      emailService: createOutbox(true),
      now: start + 1,
    }),
  );

  // As the daily run sends the cancellation, an administrator schedules it
  // again; that waits for the email, then sends its own.
  const outbox = createOutbox();
  let rescheduling: Promise<unknown> | undefined;
  const reschedulingOutbox: EmailService = {
    ...outbox,
    async send(message, options) {
      if (!rescheduling && message.to === owner.email) {
        rescheduling = scheduleAs(admin, envelope.envelopeId, "Again.", {
          now: start + DAY,
        });
        await delay(300);
      }

      return outbox.send(message, options);
    },
  };

  await runDaily(start + DAY, reschedulingOutbox);
  await rescheduling;

  assert.deepEqual(
    emailsTo(owner.email)
      .map((message) => message.subject)
      .slice(1),
    [
      '"Lease" will not be deleted',
      `"Lease" will be deleted on ${new Date((start + DAY + WAIT) * 1000).toISOString().slice(0, 10)}`,
    ],
  );
  assert.equal(
    (await getScheduledEnvelopeDeletion(envelope.envelopeId, database))?.reason,
    "Again.",
  );
});

test("a deletion scheduled again while the cancellation email is going out at once waits, so its own notice comes after", async () => {
  sent = [];
  const admin = await createUser("admin");
  const otherAdmin = await createUser("admin");
  const owner = await createUser("user");
  const envelope = await createEnvelope(owner.userId, { status: "completed" });
  const start = 1_100_000_000;

  await scheduleAs(admin, envelope.envelopeId, undefined, { now: start });

  // As the cancellation email goes out, another administrator schedules it
  // again; that waits for the email, then sends its own.
  const outbox = createOutbox();
  let rescheduling: Promise<unknown> | undefined;
  const reschedulingOutbox: EmailService = {
    ...outbox,
    async send(message, options) {
      if (!rescheduling && message.to === owner.email) {
        rescheduling = scheduleAs(otherAdmin, envelope.envelopeId, "Again.", {
          now: start + 2,
        });
        await delay(300);
      }

      return outbox.send(message, options);
    },
  };

  await cancelAs(admin, envelope.envelopeId, {
    emailService: reschedulingOutbox,
    now: start + 1,
  });
  await rescheduling;

  assert.deepEqual(
    emailsTo(owner.email)
      .map((message) => message.subject)
      .slice(1),
    [
      '"Lease" will not be deleted',
      `"Lease" will be deleted on ${new Date((start + 2 + WAIT) * 1000).toISOString().slice(0, 10)}`,
    ],
  );
  assert.equal(
    (await getScheduledEnvelopeDeletion(envelope.envelopeId, database))?.reason,
    "Again.",
  );
});

test("notices that keep failing go behind the others, so later senders are still told", async () => {
  sent = [];
  const admin = await createUser("admin");
  const unreachable = await createUser("user");
  const reachable = await createUser("user");
  // Long ago, so these come before anything else waiting.
  const start = 500_000_000;

  // A full batch of requests whose sender's email keeps bouncing…
  // Two statements rather than one data-modifying WITH, so that the same
  // setup runs on the SQLite backend too.
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        completed_at
      )
      select
        gen_random_uuid()::text, $1, 'Lease', 'completed',
        'users/' || $1 || '/envelopes/' || n || '/source.pdf', 'lease.pdf',
        4, 1, $2, $3, $3
      from generate_series(1, $4::int) as n
    `,
    [unreachable.userId, SOURCE_HASH, start, SCHEDULED_DELETIONS_PER_RUN],
  );
  await database.query(
    `
      insert into scheduled_envelope_deletions (
        envelope_id, requested_by_user_id, requested_by_email, requested_at,
        delete_after
      )
      select id, $2, $3, $4::bigint, $4::bigint + $5::bigint
      from envelopes where user_id = $1
    `,
    [unreachable.userId, admin.userId, admin.email, start, WAIT],
  );
  // …and one asked for after them.
  const later = await createEnvelope(reachable.userId, { status: "completed" });

  await quietly(() =>
    scheduleAs(admin, later.envelopeId, undefined, {
      emailService: createOutbox(true),
      now: start + 1,
    }),
  );

  const bouncing = createOutbox();
  const outbox: EmailService = {
    ...bouncing,
    async send(message, options) {
      if (message.to === unreachable.email) {
        throw new Error("Mailbox unavailable.");
      }

      return bouncing.send(message, options);
    },
  };

  // The first run tries the oldest ones; the next reaches the later sender.
  await quietly(() => runDaily(start + DAY, outbox));
  await quietly(() => runDaily(start + 2 * DAY, outbox));

  assert.equal(emailsTo(reachable.email).length, 1);
  assert.ok(
    (await getScheduledEnvelopeDeletion(later.envelopeId, database))
      ?.deleteAfter,
  );
});

test("a cancelled deletion can be scheduled again", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "voided" });
  const now = Math.floor(Date.now() / 1000);

  await scheduleAs(admin, envelope.envelopeId, "First.", { now });
  await cancelAs(admin, envelope.envelopeId, { now: now + 10 });

  const again = await scheduleAs(admin, envelope.envelopeId, "Second.", {
    now: now + 20,
  });

  assert.equal(again.deleteAfter, now + 20 + WAIT);
  assert.equal(
    (await getScheduledEnvelopeDeletion(envelope.envelopeId, database))?.reason,
    "Second.",
  );
  assert.equal(await deleteWhenDue(envelope.envelopeId, now + 20 + WAIT), true);
});

test(
  "a cancelled deletion scheduled again while the daily run clears cancelled ones is kept",
  {
    // One writer: the run and the reschedule cannot overlap on SQLite.
    skip: isSqliteUrl(process.env.E2E_DATABASE_URL) ? "needs Postgres" : false,
  },
  async () => {
    const admin = await createUser("admin");
    const envelope = await createEnvelope(admin.userId, { status: "voided" });
    const start = 1_200_000_000;

    await scheduleAs(admin, envelope.envelopeId, "First.", { now: start });
    await cancelAs(admin, envelope.envelopeId, { now: start + 10 });

    // Two days on, an administrator schedules it again. The reschedule has
    // just replaced the cancelled request, and holds its row, when the
    // daily run comes to clear the cancelled requests.
    let holding!: () => void;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rescheduling = scheduleEnvelopeDeletion(
      envelope.envelopeId,
      { actor: admin, reason: "Again." },
      {
        database: afterStatement(
          database,
          (text) => text.includes("INSERT INTO scheduled_envelope_deletions"),
          async () => {
            holding();
            await released;
          },
        ),
        emailService: createOutbox(),
        now: start + 2 * DAY,
      },
    );

    rescheduling.catch(() => undefined);
    await held;

    const running = runDaily(start + 2 * DAY);

    running.catch(() => undefined);

    try {
      // The run's clean-up waits for the reschedule's row…
      for (let attempt = 0; ; attempt += 1) {
        const waiting = await database.query(
          `
            select 1
            from pg_stat_activity
            where datname = current_database()
              and wait_event_type = 'Lock'
              and query ilike '%delete from scheduled_envelope_deletions%'
            limit 1
          `,
        );

        if (waiting.rowCount) {
          break;
        }

        if (attempt === 500) {
          throw new Error("The daily run never waited for the reschedule.");
        }

        await delay(10);
      }
    } finally {
      // …which then goes in.
      release();
    }

    await rescheduling;
    await running;

    // The request stands again; it is not cleared as the cancelled one was.
    assert.equal(
      (await getScheduledEnvelopeDeletion(envelope.envelopeId, database))
        ?.reason,
      "Again.",
    );
  },
);

test("when a file cannot be deleted, the envelope is still deleted and recorded, and the next cleanup deletes the file", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);
  const failingStorage = {
    ...storageService,
    deleteObject: async () => {
      throw new Error("Storage is down.");
    },
  } as StorageService;
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;

  await scheduleAs(admin, envelope.envelopeId, undefined, { now });

  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    await deleteWhenDue(envelope.envelopeId, now + WAIT, failingStorage);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(await envelopeExists(envelope.envelopeId), false);

  const event = await latestEvent();

  assert.equal(event?.event, "envelope_deleted");
  assert.equal(event?.metadata?.envelopeId, envelope.envelopeId);
  for (const key of envelope.stored) {
    assert.ok(
      logged.some((args) => String(args[0]).includes(key)),
      `expected ${key} to be logged`,
    );
  }
  assert.ok((await filesExist(envelope.stored)).every(Boolean));
  assert.ok(
    (await pendingFileDeletions(envelope.envelopeId)).length >=
      envelope.stored.length,
  );

  // Storage is back: the daily cleanup finishes the job.
  const summary = await runRetentionSweep({ database, storageService });

  assert.ok(summary.pendingFileDeletionsDone >= envelope.stored.length);
  assert.deepEqual(
    await filesExist(envelope.stored),
    envelope.stored.map(() => false),
  );
  assert.deepEqual(await pendingFileDeletions(envelope.envelopeId), []);
});

test("a scheduled deletion whose files cannot be deleted is reported as failed", async () => {
  const admin = await createUser("admin");
  const failing = await createEnvelope(admin.userId, { status: "completed" });
  const working = await createEnvelope(admin.userId, { status: "completed" });
  const now = 1_200_000_000;
  const failingStorage = {
    ...storageService,
    deleteObject: async () => {
      throw new Error("Storage is down.");
    },
  } as StorageService;

  await scheduleAs(admin, failing.envelopeId, undefined, { now });
  await scheduleAs(admin, working.envelopeId, undefined, { now: now + 1 });

  const down = await quietly(() =>
    runScheduledEnvelopeDeletions({
      database,
      emailService: createOutbox(),
      now: now + WAIT,
      storageService: failingStorage,
    }),
  );

  assert.equal(await envelopeExists(failing.envelopeId), false);
  assert.ok(down.failures.includes(failing.envelopeId));

  // Storage is back: the cleanup takes the queued files, and a deletion
  // whose files all go is not a failure.
  await runRetentionSweep({ database, storageService });

  const up = await runDaily(now + 1 + WAIT);

  assert.equal(await envelopeExists(working.envelopeId), false);
  assert.ok(!up.failures.includes(working.envelopeId));
  assert.deepEqual(await pendingFileDeletions(failing.envelopeId), []);
});

test("a deletion that is not due touches no file", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);
  let deletes = 0;
  const countingStorage = {
    ...storageService,
    deleteObject: async (key: string) => {
      deletes += 1;
      return storageService.deleteObject(key);
    },
  } as StorageService;

  // Not scheduled at all, then scheduled but not due.
  assert.equal(
    await deleteWhenDue(envelope.envelopeId, now + WAIT, countingStorage),
    false,
  );
  await scheduleAs(admin, envelope.envelopeId, undefined, { now });
  assert.equal(
    await deleteWhenDue(envelope.envelopeId, now, countingStorage),
    false,
  );
  assert.equal(deletes, 0);
  assert.equal(await envelopeExists(envelope.envelopeId), true);
  assert.ok((await filesExist(envelope.stored)).every(Boolean));
});

test("an administrator whose role is being taken away waits for it, and is then refused", async () => {
  const admin = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });
  const demotion = await database.connect();

  try {
    // As taking the role away does: the account row first.
    await demotion.query("begin");
    await demotion.query(
      `select id from public."user" where id = $1 for update`,
      [admin.userId],
    );

    const scheduling = scheduleAs(admin, envelope.envelopeId, "Done.");

    await delay(300);
    await demotion.query(
      `update public."user" set role = 'user' where id = $1`,
      [admin.userId],
    );
    await demotion.query("commit");

    await assert.rejects(scheduling, rejectsWith(403));
  } finally {
    demotion.release();
  }

  assert.equal(
    await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
    null,
  );
});

test("a request running while the administrator's handed-over envelopes move does not deadlock", async () => {
  const admin = await createUser("admin");
  const keeper = await createUser("admin");
  const envelope = await createEnvelope(admin.userId, { status: "completed" });
  const demotion = await database.connect();

  try {
    // In the order taking the role away uses: the account row, the audit
    // trail lock, then the envelopes it moves to the administrator who stays.
    await demotion.query("begin");
    await demotion.query(
      `select id from public."user" where id = $1 for update`,
      [admin.userId],
    );
    await demotion.query(
      `update public."user" set role = 'user' where id = $1`,
      [admin.userId],
    );
    await demotion.query("select pg_advisory_xact_lock($1)", [
      SYSTEM_AUDIT_LOCK_ID,
    ]);

    const scheduling = scheduleAs(admin, envelope.envelopeId, "Done.");

    await delay(300);
    await demotion.query(`update envelopes set user_id = $1 where id = $2`, [
      keeper.userId,
      envelope.envelopeId,
    ]);
    await demotion.query("commit");

    // It moved while the request waited: told to look again.
    await assert.rejects(scheduling, rejectsWith(409));
  } finally {
    demotion.release();
  }

  assert.equal(
    await getScheduledEnvelopeDeletion(envelope.envelopeId, database),
    null,
  );
});

test("a scheduled deletion still runs after the administrator who asked loses the role", async () => {
  const admin = await createUser("admin");
  const keeper = await createUser("admin");
  const envelope = await createEnvelope(keeper.userId, { status: "completed" });
  const now = Math.floor(Date.now() / 1000);

  await scheduleAs(admin, envelope.envelopeId, "Asked for.", { now });
  await database.query(`update public."user" set role = 'user' where id = $1`, [
    admin.userId,
  ]);

  assert.equal(await deleteWhenDue(envelope.envelopeId, now + WAIT), true);
  assert.equal(await envelopeExists(envelope.envelopeId), false);
});

test("a file that keeps failing goes to the back of the queue, so the others are still reached", async () => {
  const envelopeId = randomUUID();
  const stuck = `test/${envelopeId}/stuck.pdf`;
  const healthy = `test/${envelopeId}/healthy.pdf`;
  // Older than anything else in the queue, so both come first.
  const longAgo = 1;

  for (const key of [stuck, healthy]) {
    await storageService.putObject({
      body: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
      key,
    });
  }
  await queueFileDeletions(envelopeId, [stuck], longAgo, database);
  await queueFileDeletions(envelopeId, [healthy], longAgo + 1, database);

  const stuckStorage = {
    ...storageService,
    deleteObject: async (key: string) => {
      if (key === stuck) {
        throw new Error("Storage refuses this one.");
      }

      return storageService.deleteObject(key);
    },
  } as StorageService;
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    // One at a time: the stuck file first, then, as it was just tried, the
    // healthy one.
    assert.equal(await deletePendingFiles(database, stuckStorage, 1), 0);
    assert.equal(await deletePendingFiles(database, stuckStorage, 1), 1);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(await filesExist([stuck, healthy]), [true, false]);
  assert.deepEqual(await pendingFileDeletions(envelopeId), [stuck]);

  await deletePendingFiles(database, storageService);
  assert.deepEqual(await pendingFileDeletions(envelopeId), []);
});
