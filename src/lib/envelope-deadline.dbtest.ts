import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { runEnvelopeSchedule } from "./envelope-schedule.ts";
import { changeEnvelopeDeadline, EnvelopeMutationError } from "./envelopes.ts";
import { ReminderMutationError, sendManualEnvelopeNudge } from "./reminders.ts";
import { verifyAuditChain } from "./services/audit.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import { recordSignerConsent, SigningAccessError } from "./signing.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";

// An envelope's deadline against a real Postgres: what a passed deadline
// stops, what a new one brings back, and the one notice the daily job sends.
// Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

/** An envelope out for signature, waiting on its one signer. */
async function createSentEnvelope({
  expiresAt,
  status = "sent",
}: {
  expiresAt: number | null;
  status?: "draft" | "sent";
}) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const sentAt = unixNow() - 40 * DAY;
  const link = await issueSigningLink({
    expiresInSeconds: 60,
    issuedAt: sentAt,
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
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at, expires_at
      ) values ($1, $2, 'Lease', $3, $4, 'lease.pdf', 10, 1, $5, $6, $7)
    `,
    [
      envelopeId,
      userId,
      status,
      `test/${envelopeId}.pdf`,
      "a".repeat(64),
      status === "sent" ? sentAt : null,
      expiresAt,
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
      status === "sent" ? "notified" : "pending",
      status === "sent" ? link.tokenHash : null,
      status === "sent" ? link.exp : null,
      status === "sent" ? sentAt : null,
    ],
  );

  return { envelopeId, signerId, token: link.token, userId };
}

async function readEnvelope(envelopeId: string) {
  const result = await database.query<{
    expires_at: number | null;
    expiry_notified_at: number | null;
  }>(`select expires_at, expiry_notified_at from envelopes where id = $1`, [
    envelopeId,
  ]);

  return result.rows[0]!;
}

async function auditEvents(envelopeId: string) {
  const result = await database.query<{ event: string }>(
    `select event from audit_events where envelope_id = $1 order by sequence`,
    [envelopeId],
  );

  return result.rows.map((row) => row.event);
}

function consent(token: string) {
  return recordSignerConsent(
    token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );
}

function recordingEmailService(failWith?: Error) {
  const sent: TransactionalEmailMessage[] = [];
  const service: EmailService = {
    async send(message) {
      if (failWith) {
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

test("a passed deadline stops signing, and a new one brings the same link back", async () => {
  const { envelopeId, signerId, token, userId } = await createSentEnvelope({
    expiresAt: unixNow() - 60,
  });

  await assert.rejects(consent(token), (error: unknown) => {
    assert.ok(error instanceof SigningAccessError);
    assert.equal(error.state, "expired");
    return true;
  });

  const before = unixNow();
  const changed = await changeEnvelopeDeadline(
    userId,
    envelopeId,
    { expiresInDays: 7, senderEmail: "sam@example.test" },
    { database },
  );

  assert.ok(changed.expiresAt >= before + 7 * DAY);
  assert.equal((await readEnvelope(envelopeId)).expires_at, changed.expiresAt);

  const signer = await database.query<{ signing_token_expires_at: number }>(
    `select signing_token_expires_at from signers where id = $1`,
    [signerId],
  );

  // The link the signer already holds now lasts until the new deadline.
  assert.equal(signer.rows[0]?.signing_token_expires_at, changed.expiresAt);
  assert.ok((await consent(token)).consentedAt > 0);
  assert.deepEqual(await auditEvents(envelopeId), [
    "deadline_changed",
    "consented",
  ]);
  assert.equal((await verifyAuditChain(envelopeId, database)).ok, true);
});

test("a link that outlives the envelope's deadline does not work past it", async () => {
  const { signerId, token } = await createSentEnvelope({
    expiresAt: unixNow() - 60,
  });

  await database.query(
    `update signers set signing_token_expires_at = $1 where id = $2`,
    [unixNow() + DAY, signerId],
  );

  await assert.rejects(consent(token), SigningAccessError);
});

test("only the owner of an envelope that is out can change its deadline", async () => {
  const sent = await createSentEnvelope({ expiresAt: unixNow() + DAY });
  const draft = await createSentEnvelope({ expiresAt: null, status: "draft" });
  const input = { expiresInDays: 7, senderEmail: "sam@example.test" };

  await assert.rejects(
    changeEnvelopeDeadline(draft.userId, sent.envelopeId, input, { database }),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 404,
  );
  await assert.rejects(
    changeEnvelopeDeadline(draft.userId, draft.envelopeId, input, { database }),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 409,
  );
  assert.deepEqual(await auditEvents(sent.envelopeId), []);
});

test("a reminder is refused once the deadline has passed", async () => {
  const { envelopeId, userId } = await createSentEnvelope({
    expiresAt: unixNow() - 60,
  });

  await assert.rejects(
    sendManualEnvelopeNudge(
      userId,
      envelopeId,
      { senderEmail: "sam@example.test", senderName: "Sam Sender" },
      { database },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReminderMutationError);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /^This request expired on /);
      return true;
    },
  );
  assert.deepEqual(await auditEvents(envelopeId), []);
});

test("the daily job tells the sender once that a deadline passed", async () => {
  const now = unixNow();
  const expired = await createSentEnvelope({ expiresAt: now - 60 });
  const open = await createSentEnvelope({ expiresAt: now + DAY });
  const legacy = await createSentEnvelope({ expiresAt: null });
  const { sent, service } = recordingEmailService();

  const first = await runEnvelopeSchedule({
    database,
    emailService: service,
    now,
  });
  const mine = sent.filter((message) => message.to.startsWith(expired.userId));

  assert.equal(first.expiryNoticeFailures.length, 0);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.template, "expiry_notice");
  assert.equal(mine[0]?.subject, '"Lease" expired before everyone signed');
  assert.match(mine[0]?.textBody ?? "", /still waiting on Riley Recipient \(/);
  assert.match(
    mine[0]?.textBody ?? "",
    new RegExp(`/envelopes/${expired.envelopeId}$`),
  );
  assert.equal(
    (await readEnvelope(expired.envelopeId)).expiry_notified_at,
    now,
  );
  assert.deepEqual(await auditEvents(expired.envelopeId), ["expired"]);

  // Nothing for one still inside its deadline, or one that never had one.
  assert.equal(
    sent.some(
      (message) =>
        message.to.startsWith(open.userId) ||
        message.to.startsWith(legacy.userId),
    ),
    false,
  );

  await runEnvelopeSchedule({
    database,
    emailService: service,
    now: now + DAY,
  });

  assert.equal(
    sent.filter((message) => message.to.startsWith(expired.userId)).length,
    1,
  );

  // A new deadline that passes in turn is a new thing to tell.
  const changed = await changeEnvelopeDeadline(
    expired.userId,
    expired.envelopeId,
    { expiresInDays: 1, senderEmail: "sam@example.test" },
    { database },
  );

  assert.equal(
    (await readEnvelope(expired.envelopeId)).expiry_notified_at,
    null,
  );

  await runEnvelopeSchedule({
    database,
    emailService: service,
    now: changed.expiresAt + 1,
  });

  assert.equal(
    sent.filter((message) => message.to.startsWith(expired.userId)).length,
    2,
  );
  assert.deepEqual(await auditEvents(expired.envelopeId), [
    "expired",
    "deadline_changed",
    "expired",
  ]);
  assert.equal((await verifyAuditChain(expired.envelopeId, database)).ok, true);
});

test("a notice whose email fails is tried again on the next run", async () => {
  const now = unixNow();
  const { envelopeId, userId } = await createSentEnvelope({
    expiresAt: now - 60,
  });
  const failing = recordingEmailService(new Error("mail is down"));

  const failed = await runEnvelopeSchedule({
    database,
    emailService: failing.service,
    now,
  });

  assert.ok(failed.expiryNoticeFailures.includes(envelopeId));
  assert.equal((await readEnvelope(envelopeId)).expiry_notified_at, null);
  assert.deepEqual(await auditEvents(envelopeId), []);

  const working = recordingEmailService();

  await runEnvelopeSchedule({
    database,
    emailService: working.service,
    now: now + 60,
  });

  assert.equal(
    working.sent.filter((message) => message.to.startsWith(userId)).length,
    1,
  );
  assert.deepEqual(await auditEvents(envelopeId), ["expired"]);
});
