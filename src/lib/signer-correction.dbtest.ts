import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ZodError } from "zod";

import type pg from "pg";

import { exportEnvelopeAuditCsv } from "./audit-export.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  correctSentEnvelopeSigner,
  EnvelopeMutationError,
  getEnvelopeDetailDataForUser,
} from "./envelopes.ts";
import { duplicateSignerEmailMessage } from "./schemas/signer.ts";
import { verifyAuditChain } from "./services/audit.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import { getSigningPayloadForToken, SigningAccessError } from "./signing.ts";

// Correcting a waiting signer's name or email on a sent envelope, against
// a real Postgres. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
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

async function createOwner() {
  const userId = randomUUID();
  const email = `${userId}@example.test`;

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, email],
  );

  return { email, userId };
}

async function createEnvelope({
  expiresAt = unixNow() + 30 * DAY,
  part11 = false,
  status = "sent",
  userId,
}: {
  expiresAt?: number | null;
  part11?: boolean;
  status?: "completed" | "declined" | "draft" | "sent" | "voided";
  userId: string;
}) {
  const envelopeId = randomUUID();
  const sentAt = status === "draft" ? null : unixNow() - 60;

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        expires_at, part11, completed_at, declined_at, voided_at
      ) values (
        $1, $2, 'Lease', $3, $4, 'lease.pdf', 10, 1, $5, $6, $7, $8,
        $9, $10, $11
      )
    `,
    [
      envelopeId,
      userId,
      status,
      `test/${envelopeId}.pdf`,
      "a".repeat(64),
      sentAt,
      status === "draft" ? null : expiresAt,
      part11,
      status === "completed" ? unixNow() : null,
      status === "declined" ? unixNow() : null,
      status === "voided" ? unixNow() : null,
    ],
  );

  return envelopeId;
}

async function createSigner({
  email,
  envelopeId,
  extra,
  name = "Riley Recipient",
  signOrder = 1,
  status = "notified",
}: {
  email?: string;
  envelopeId: string;
  extra?: {
    consentedAt?: number | null;
    emailCodeAttempts?: number;
    emailCodeExpiresAt?: number | null;
    emailCodeHash?: string | null;
    emailCodeSentAt?: number | null;
  };
  name?: string;
  signOrder?: number;
  status?: "declined" | "notified" | "pending" | "signed";
}) {
  const signerId = randomUUID();
  const link =
    status === "notified"
      ? await issueSigningLink({ expiresInSeconds: 30 * DAY })
      : null;

  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at,
        signed_at, declined_at, email_code_hash, email_code_expires_at,
        email_code_attempts, email_code_sent_at, consented_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      )
    `,
    [
      signerId,
      envelopeId,
      name,
      email ?? `${signerId}@example.test`,
      signOrder,
      status,
      link?.tokenHash ?? null,
      link?.exp ?? null,
      status === "notified" ? unixNow() : null,
      status === "signed" ? unixNow() : null,
      status === "declined" ? unixNow() : null,
      extra?.emailCodeHash ?? null,
      extra?.emailCodeExpiresAt ?? null,
      extra?.emailCodeAttempts ?? 0,
      extra?.emailCodeSentAt ?? null,
      extra?.consentedAt ?? null,
    ],
  );

  return {
    email: email ?? `${signerId}@example.test`,
    signerId,
    token: link?.token ?? null,
    tokenHash: link?.tokenHash ?? null,
  };
}

async function readSigner(signerId: string) {
  const result = await database.query<{
    consented_at: number | null;
    email: string;
    email_code_attempts: number;
    email_code_hash: string | null;
    email_code_sent_at: number | null;
    name: string;
    signing_token_hash: string | null;
    status: string;
  }>(
    `
      select
        consented_at, email, email_code_attempts, email_code_hash,
        email_code_sent_at, name, signing_token_hash, status
      from signers
      where id = $1
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

function correct(
  userId: string,
  envelopeId: string,
  signerId: string,
  body: unknown,
  emailService?: EmailService,
) {
  return correctSentEnvelopeSigner(
    userId,
    envelopeId,
    signerId,
    body,
    {
      ipAddress: "203.0.113.8",
      senderEmail: "sam@example.test",
      senderName: "Sam Sender",
      userAgent: "test",
    },
    { database, emailService },
  );
}

test("correcting a notified signer rotates the link and emails the new address", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({ userId });
  const signer = await createSigner({
    envelopeId,
    extra: {
      consentedAt: unixNow() - 10,
      emailCodeAttempts: 2,
      emailCodeExpiresAt: unixNow() + 600,
      emailCodeHash: "a".repeat(64),
      emailCodeSentAt: unixNow() - 30,
    },
  });
  const { sent, service } = recordingEmailService();
  const oldToken = signer.token!;

  const result = await correct(
    userId,
    envelopeId,
    signer.signerId,
    { email: "riley.fixed@example.test", name: "Riley Recipient" },
    service,
  );

  assert.equal(result.invitationSent, true);
  assert.equal(result.email, "riley.fixed@example.test");
  const stored = await readSigner(signer.signerId);
  assert.equal(stored.email, "riley.fixed@example.test");
  assert.notEqual(stored.signing_token_hash, signer.tokenHash);
  assert.equal(stored.consented_at, null);
  assert.equal(stored.email_code_hash, null);
  assert.equal(stored.email_code_attempts, 0);
  assert.equal(stored.email_code_sent_at, null);

  await assert.rejects(getSigningPayloadForToken(oldToken, { database }), {
    message: "This link has expired.",
    name: "SigningAccessError",
  });
  await assert.rejects(
    getSigningPayloadForToken(oldToken, { database }),
    (error: unknown) => {
      assert.ok(error instanceof SigningAccessError);
      assert.equal(error.state, "expired");
      return true;
    },
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, "riley.fixed@example.test");
  assert.equal(sent[0]?.template, "signing_invitation");
  const match = sent[0]?.textBody.match(/\/sign\/([A-Za-z0-9_-]+)/);
  assert.ok(match?.[1]);
  assert.equal(stored.signing_token_hash, hashOpaqueToken(match[1]!));

  assert.deepEqual(await auditEvents(envelopeId), [
    "signer_corrected",
    "email_sent",
  ]);
  assert.equal((await verifyAuditChain(envelopeId, database)).ok, true);

  const detail = await getEnvelopeDetailDataForUser(
    userId,
    envelopeId,
    database,
  );
  assert.ok(
    detail?.timeline.some((item) =>
      item.description.includes(
        "Signer email corrected from " +
          `${signer.email} to riley.fixed@example.test`,
      ),
    ),
  );

  const csv = await exportEnvelopeAuditCsv(userId, envelopeId, database);
  assert.match(csv.body, /Signer corrected/);
  assert.match(
    csv.body,
    /Signer email corrected from .* to riley\.fixed@example\.test/,
  );
});

test("correcting a pending signer records the change and sends no invitation", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({ userId });
  await createSigner({ envelopeId, signOrder: 1, status: "notified" });
  const pending = await createSigner({
    envelopeId,
    name: "Casey Second",
    signOrder: 2,
    status: "pending",
  });
  const { sent, service } = recordingEmailService();

  const result = await correct(
    userId,
    envelopeId,
    pending.signerId,
    { email: "casey.fixed@example.test" },
    service,
  );

  assert.equal(result.invitationSent, false);
  assert.equal(sent.length, 0);
  assert.equal(
    (await readSigner(pending.signerId)).email,
    "casey.fixed@example.test",
  );
  assert.deepEqual(await auditEvents(envelopeId), ["signer_corrected"]);
  assert.equal((await verifyAuditChain(envelopeId, database)).ok, true);
});

test("the same name and email is a no-op: the link stays and nothing is audited", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({ userId });
  const signer = await createSigner({
    email: "riley@example.test",
    envelopeId,
    name: "Riley Recipient",
  });
  const { sent, service } = recordingEmailService();

  const result = await correct(
    userId,
    envelopeId,
    signer.signerId,
    { email: "Riley@Example.TEST", name: "Riley Recipient" },
    service,
  );

  assert.equal(result.invitationSent, false);
  assert.equal(result.email, "riley@example.test");
  assert.equal(
    (await readSigner(signer.signerId)).signing_token_hash,
    signer.tokenHash,
  );
  assert.equal(sent.length, 0);
  assert.deepEqual(await auditEvents(envelopeId), []);
  const stillLinked = await database.query<{ id: string }>(
    `select id from signers where signing_token_hash = $1`,
    [hashOpaqueToken(signer.token!)],
  );
  assert.equal(stillLinked.rows[0]?.id, signer.signerId);
});

test("a passed deadline can still have a signer corrected", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({
    expiresAt: unixNow() - 60,
    userId,
  });
  const signer = await createSigner({ envelopeId });
  const { sent, service } = recordingEmailService();

  const result = await correct(
    userId,
    envelopeId,
    signer.signerId,
    { name: "Riley Fixed" },
    service,
  );

  assert.equal(result.invitationSent, true);
  assert.equal(sent.length, 1);
  assert.notEqual(
    (await readSigner(signer.signerId)).signing_token_hash,
    signer.tokenHash,
  );
  await assert.rejects(getSigningPayloadForToken(signer.token!, { database }), {
    name: "SigningAccessError",
  });
});

test("another signer's email is refused", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({ userId });
  const first = await createSigner({
    email: "riley@example.test",
    envelopeId,
  });
  const second = await createSigner({
    email: "casey@example.test",
    envelopeId,
    name: "Casey Second",
    signOrder: 2,
    status: "pending",
  });

  await assert.rejects(
    correct(userId, envelopeId, second.signerId, {
      email: "riley@example.test",
    }),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, duplicateSignerEmailMessage);
      return true;
    },
  );
  assert.equal((await readSigner(first.signerId)).email, "riley@example.test");
});

test("a signed or declined signer cannot be corrected", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({ userId });
  const signed = await createSigner({
    envelopeId,
    status: "signed",
  });
  const declined = await createSigner({
    envelopeId,
    name: "Casey Second",
    signOrder: 2,
    status: "declined",
  });

  await assert.rejects(
    correct(userId, envelopeId, signed.signerId, { name: "Nope" }),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /already signed/);
      return true;
    },
  );
  await assert.rejects(
    correct(userId, envelopeId, declined.signerId, { name: "Nope" }),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /already declined/);
      return true;
    },
  );
});

test("a copy recipient cannot be corrected here", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({ userId });
  await createSigner({ envelopeId });
  const copyId = randomUUID();
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status, role
      ) values ($1, $2, 'Zofia Copy', 'zofia@example.test', 501, 'pending', 'cc')
    `,
    [copyId, envelopeId],
  );

  await assert.rejects(
    correct(userId, envelopeId, copyId, { email: "zofia.fixed@example.test" }),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test("draft, completed, declined and voided envelopes are refused", async () => {
  const { userId } = await createOwner();

  for (const status of ["draft", "completed", "declined", "voided"] as const) {
    const envelopeId = await createEnvelope({ status, userId });
    const signer = await createSigner({
      envelopeId,
      status: status === "draft" ? "pending" : "notified",
    });

    await assert.rejects(
      correct(userId, envelopeId, signer.signerId, { name: "Nope" }),
      (error: unknown) => {
        assert.ok(error instanceof EnvelopeMutationError);
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /out for signature/);
        return true;
      },
    );
  }
});

test("a Part 11 envelope cannot have a signer corrected", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({ part11: true, userId });
  const signer = await createSigner({ envelopeId });

  await assert.rejects(
    correct(userId, envelopeId, signer.signerId, {
      email: "riley.fixed@example.test",
    }),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Part 11/);
      return true;
    },
  );
});

test("another user cannot correct a signer", async () => {
  const owner = await createOwner();
  const other = await createOwner();
  const envelopeId = await createEnvelope({ userId: owner.userId });
  const signer = await createSigner({ envelopeId });

  await assert.rejects(
    correct(other.userId, envelopeId, signer.signerId, { name: "Nope" }),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test("an empty or invalid correction is refused by the schema", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({ userId });
  const signer = await createSigner({ envelopeId });

  await assert.rejects(
    correct(userId, envelopeId, signer.signerId, {}),
    ZodError,
  );
  await assert.rejects(
    correct(userId, envelopeId, signer.signerId, { email: "not-an-email" }),
    ZodError,
  );
});

test("a failed invitation leaves the old name, email and link in place", async () => {
  const { userId } = await createOwner();
  const envelopeId = await createEnvelope({ userId });
  const signer = await createSigner({ envelopeId });
  const { service } = recordingEmailService(new Error("mailbox down"));

  await assert.rejects(
    correct(
      userId,
      envelopeId,
      signer.signerId,
      { email: "riley.fixed@example.test" },
      service,
    ),
    { message: "mailbox down" },
  );

  const stored = await readSigner(signer.signerId);
  assert.equal(stored.email, signer.email);
  assert.equal(stored.signing_token_hash, signer.tokenHash);
  assert.deepEqual(await auditEvents(envelopeId), []);
});
