import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { runEnvelopeSchedule } from "./envelope-schedule.ts";
import {
  changeEnvelopeDeadline,
  changeEnvelopeReminders,
  EnvelopeMutationError,
} from "./envelopes.ts";
import { verifyAuditChain } from "./services/audit.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import { issueSigningLink } from "./services/signing-links.ts";

// Automatic reminders against a real Postgres: who the daily job reminds,
// how often, and what a failed email leaves behind.
// Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
// Far from the present, so envelopes left by other tests are never due.
const SENT_AT = 1_500_000_000;

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  // The reminder email reads the install's name through the shared pool.
  globalThis.__signudocPgPool = database;
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

/** An envelope sent at SENT_AT and waiting on its one signer. */
async function createSentEnvelope({
  expiresAt = SENT_AT + 30 * DAY,
  reminderIntervalDays,
  signerStatus = "notified",
}: {
  expiresAt?: number | null;
  reminderIntervalDays: number | null;
  signerStatus?: "notified" | "signed";
}) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const link = await issueSigningLink({
    expiresInSeconds: 30 * DAY,
    issuedAt: SENT_AT,
  });

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        expires_at, reminder_interval_days
      ) values ($1, $2, 'Lease', 'sent', $3, 'lease.pdf', 10, 1, $4, $5, $6, $7)
    `,
    [
      envelopeId,
      userId,
      `test/${envelopeId}.pdf`,
      "a".repeat(64),
      SENT_AT,
      expiresAt,
      reminderIntervalDays,
    ],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at
      ) values ($1, $2, 'Riley Recipient', $3, 1, $4, $5, $6, $7)
    `,
    [
      signerId,
      envelopeId,
      `${signerId}@example.test`,
      signerStatus,
      signerStatus === "notified" ? link.tokenHash : null,
      signerStatus === "notified" ? link.exp : null,
      SENT_AT,
    ],
  );

  return { envelopeId, signerId, tokenHash: link.tokenHash, userId };
}

async function readSigner(signerId: string) {
  const result = await database.query<{
    last_notified_at: number | null;
    last_nudged_at: number | null;
    signing_token_expires_at: number | null;
    signing_token_hash: string | null;
  }>(
    `
      select signing_token_hash, signing_token_expires_at, last_notified_at,
        last_nudged_at
      from signers where id = $1
    `,
    [signerId],
  );

  return result.rows[0]!;
}

async function auditEvents(envelopeId: string) {
  const result = await database.query<{ event: string }>(
    `select event from audit_events where envelope_id = $1 order by sequence`,
    [envelopeId],
  );

  return result.rows.map((row) => row.event);
}

function recordingEmailService(
  failWith?: Error,
  beforeFailing?: (message: TransactionalEmailMessage) => Promise<void>,
) {
  const sent: TransactionalEmailMessage[] = [];
  const service: EmailService = {
    async send(message) {
      if (failWith) {
        await beforeFailing?.(message);
        throw failWith;
      }

      sent.push(message);

      return { accepted: [message.to], messageId: "m-1", rejected: [] };
    },
    async sendBatch() {
      throw new Error("not used");
    },
  };

  return { sent, service };
}

function run(now: number, service: EmailService) {
  return runEnvelopeSchedule({ database, emailService: service, now });
}

test("the daily job reminds the waiting signer once per interval", async () => {
  const due = await createSentEnvelope({ reminderIntervalDays: 3 });
  const { sent, service } = recordingEmailService();
  const toSigner = () =>
    sent.filter((message) => message.to.startsWith(due.signerId));

  // Two days in, nothing yet.
  await run(SENT_AT + 2 * DAY, service);
  assert.equal(toSigner().length, 0);

  const firstRunAt = SENT_AT + 3 * DAY - HOUR;
  const first = await run(firstRunAt, service);

  assert.deepEqual(first.reminderFailures, []);
  assert.equal(toSigner().length, 1);

  const reminder = toSigner()[0]!;
  const link = /https:\/\/\S+\/sign\/(\S+)/.exec(reminder.textBody);

  assert.equal(reminder.template, "automatic_reminder");
  assert.equal(
    reminder.subject,
    'Reminder: Sam Sender is waiting for your signature on "Lease"',
  );
  assert.match(reminder.textBody, /This request expires on /);
  assert.ok(link);

  // The reminder carries a new link, which lasts until the same deadline.
  const signer = await readSigner(due.signerId);

  assert.notEqual(signer.signing_token_hash, due.tokenHash);
  assert.equal(signer.signing_token_hash, hashOpaqueToken(link[1]!));
  assert.equal(signer.signing_token_expires_at, SENT_AT + 30 * DAY);
  assert.equal(signer.last_nudged_at, firstRunAt);
  assert.deepEqual(await auditEvents(due.envelopeId), [
    "reminded_auto",
    "email_sent",
  ]);

  // The same run again, and the next day's, send nothing more.
  await run(firstRunAt, service);
  await run(firstRunAt + DAY, service);
  assert.equal(toSigner().length, 1);

  await run(firstRunAt + 3 * DAY, service);
  assert.equal(toSigner().length, 2);
  assert.equal((await verifyAuditChain(due.envelopeId, database)).ok, true);
});

test("no reminder when they are off, the deadline passed, or nobody is waiting", async () => {
  const off = await createSentEnvelope({ reminderIntervalDays: null });
  const expired = await createSentEnvelope({
    expiresAt: SENT_AT + DAY,
    reminderIntervalDays: 1,
  });
  const signed = await createSentEnvelope({
    reminderIntervalDays: 1,
    signerStatus: "signed",
  });
  const { sent, service } = recordingEmailService();

  await run(SENT_AT + 5 * DAY, service);

  for (const envelope of [off, expired, signed]) {
    assert.equal(
      sent.some((message) => message.to.startsWith(envelope.signerId)),
      false,
    );
    assert.ok(
      !(await auditEvents(envelope.envelopeId)).includes("reminded_auto"),
    );
  }
});

test("a reminder whose email fails leaves the signer's link as it was", async () => {
  const due = await createSentEnvelope({ reminderIntervalDays: 1 });
  const failing = recordingEmailService(new Error("mail is down"));
  const failed = await run(SENT_AT + DAY, failing.service);

  assert.ok(failed.reminderFailures.includes(due.envelopeId));

  const signer = await readSigner(due.signerId);

  assert.equal(signer.signing_token_hash, due.tokenHash);
  assert.equal(signer.last_nudged_at, null);
  assert.equal(signer.last_notified_at, SENT_AT);
  assert.deepEqual(await auditEvents(due.envelopeId), []);

  // So the next run tries again.
  const working = recordingEmailService();

  await run(SENT_AT + DAY + HOUR, working.service);
  assert.equal(
    working.sent.filter((message) => message.to.startsWith(due.signerId))
      .length,
    1,
  );
});

test("a deadline moved while a reminder's email fails stays moved", async () => {
  const due = await createSentEnvelope({ reminderIntervalDays: 1 });
  let newDeadline: number | undefined;
  const failing = recordingEmailService(
    new Error("mail is down"),
    async (message) => {
      if (message.to.startsWith(due.signerId)) {
        newDeadline = (
          await changeEnvelopeDeadline(
            due.userId,
            due.envelopeId,
            { expiresInDays: 7, senderEmail: "sam@example.test" },
            { database },
          )
        ).expiresAt;
      }
    },
  );

  await run(SENT_AT + DAY, failing.service);

  const signer = await readSigner(due.signerId);

  // The link the signer already holds is the one that works, and it lasts
  // until the new deadline, not until the one it was issued with.
  assert.ok(newDeadline);
  assert.equal(signer.signing_token_hash, due.tokenHash);
  assert.equal(signer.signing_token_expires_at, newDeadline);
});

test("a run that is out of time leaves the rest for the next one", async () => {
  const due = await createSentEnvelope({ reminderIntervalDays: 1 });
  const { sent, service } = recordingEmailService();
  const summary = await runEnvelopeSchedule({
    database,
    emailService: service,
    now: SENT_AT + DAY,
    timeBudgetMs: 0,
  });

  assert.equal(summary.stoppedEarly, true);
  assert.equal(sent.length, 0);
  assert.equal(
    (await readSigner(due.signerId)).signing_token_hash,
    due.tokenHash,
  );
});

test("only the owner changes reminders, and only while the envelope is out", async () => {
  const mine = await createSentEnvelope({ reminderIntervalDays: null });
  const other = await createSentEnvelope({ reminderIntervalDays: null });

  await assert.rejects(
    changeEnvelopeReminders(other.userId, mine.envelopeId, 2, { database }),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 404,
  );

  assert.deepEqual(
    await changeEnvelopeReminders(mine.userId, mine.envelopeId, 2, {
      database,
    }),
    { envelopeId: mine.envelopeId, reminderIntervalDays: 2 },
  );

  const { sent, service } = recordingEmailService();

  await run(SENT_AT + 2 * DAY, service);
  assert.equal(
    sent.filter((message) => message.to.startsWith(mine.signerId)).length,
    1,
  );

  await database.query(`update envelopes set status = 'voided' where id = $1`, [
    mine.envelopeId,
  ]);
  await assert.rejects(
    changeEnvelopeReminders(mine.userId, mine.envelopeId, null, { database }),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 409,
  );
});
