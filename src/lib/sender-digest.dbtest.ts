import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  envelopeScheduleFailed,
  runEnvelopeSchedule,
} from "./envelope-schedule.ts";
import { runRetentionJob } from "./retention-job.ts";
import { clearRateLimit } from "./security/rate-limit.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { createStorageService } from "./services/storage.ts";

const env = {
  APP_URL: "https://sign.example.test",
  SIGNUDOC_EMAIL_SENDER_DAILY_DIGEST: "1",
};
const day = 86_400;
const now = Date.UTC(2010, 3, 5, 9) / 1000;
const allowSenderDigest = true;
let database: pg.Pool;
const senders: string[] = [];

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.query('DELETE FROM "user" WHERE id = ANY($1)', [senders]);
  const keys = senders.flatMap((id) =>
    ["2010-04-05", "2010-04-06", new Date().toISOString().slice(0, 10)].map(
      (date) =>
        createHash("sha256")
          .update(`sender-daily-digest/${date}/${id}`)
          .digest("hex"),
    ),
  );
  await database.query("DELETE FROM rate_limits WHERE key = ANY($1)", [keys]);
  await database.end();
});

async function createSender() {
  const id = randomUUID();
  const email = `${id}@example.test`;
  senders.push(id);
  await database.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     VALUES ($1, 'Sam Sender', $2, true)`,
    [id, email],
  );
  return { id, email };
}

async function createEnvelope(
  ownerId: string,
  title: string,
  {
    expiresAt = null,
    role = "signer",
    signerStatus = "notified",
    status = "sent",
  }: {
    expiresAt?: number | null;
    role?: "approver" | "signer";
    signerStatus?: "notified" | "pending";
    status?: "completed" | "sent";
  } = {},
) {
  const id = randomUUID();
  await database.query(
    `INSERT INTO envelopes (
       id, user_id, title, status, source_pdf_key, source_pdf_filename,
       source_pdf_size_bytes, page_count, source_pdf_hash, sent_at, expires_at
     ) VALUES ($1, $2, $3, $4, $1 || '.pdf', 'test.pdf', 10, 1, $5, $6, $7)`,
    [id, ownerId, title, status, "a".repeat(64), now - day, expiresAt],
  );
  await database.query(
    `INSERT INTO signers (id, envelope_id, name, email, sign_order, status, role)
     VALUES ($1, $2, 'Riley Recipient', 'recipient@example.test', 1, $3, $4)`,
    [randomUUID(), id, signerStatus, role],
  );
  return id;
}

test("the daily job sends one nonempty digest to each verified sender per UTC day", async () => {
  const first = await createSender();
  const second = await createSender();
  const idle = await createSender();
  const lease = await createEnvelope(first.id, "Renewal <lease>");
  const approval = await createEnvelope(first.id, "Budget approval", {
    role: "approver",
  });
  await createEnvelope(first.id, "Completed", { status: "completed" });
  await createEnvelope(first.id, "Expired", { expiresAt: now - 1 });
  await createEnvelope(idle.id, "No current signer", {
    signerStatus: "pending",
  });
  await createEnvelope(second.id, "New contract");

  const messages: { email: TransactionalEmailMessage; key?: string }[] = [];
  const emailService: EmailService = {
    async send(email, options) {
      if (email.template === "sender_daily_digest") {
        messages.push({ email, key: options?.idempotencyKey });
      }
      return { accepted: [email.to], messageId: "message", rejected: [] };
    },
    async sendBatch() {
      throw new Error("not used");
    },
  };

  await runEnvelopeSchedule({
    allowSenderDigest,
    database,
    emailService,
    now,
    env: {},
  });
  assert.equal(messages.length, 0);

  await runEnvelopeSchedule({
    allowSenderDigest,
    database,
    emailService,
    now,
    env,
  });
  assert.equal(messages.length, 2);
  const firstEmail = messages.find(({ email }) => email.to === first.email);
  assert.ok(firstEmail?.key);
  assert.match(firstEmail.email.textBody, /^Hi Sam,/);
  assert.match(firstEmail.email.textBody, /Renewal <lease>/);
  assert.match(firstEmail.email.textBody, /Budget approval/);
  assert.ok(firstEmail.email.textBody.includes(`/envelopes/${lease}`));
  assert.ok(firstEmail.email.textBody.includes(`/envelopes/${approval}`));
  assert.doesNotMatch(
    firstEmail.email.textBody,
    /New contract|Expired|Completed/,
  );
  assert.match(firstEmail.email.htmlBody ?? "", /Renewal &lt;lease&gt;/);
  assert.match(
    messages.find(({ email }) => email.to === second.email)?.email.textBody ??
      "",
    /New contract/,
  );

  await runEnvelopeSchedule({
    allowSenderDigest,
    database,
    emailService,
    now: now + 3600,
    env,
  });
  assert.equal(messages.length, 2);
  await runEnvelopeSchedule({
    allowSenderDigest,
    database,
    emailService,
    now: now + day,
    env,
  });
  assert.equal(messages.length, 4);
  assert.notEqual(
    messages.slice(2).find(({ email }) => email.to === first.email)?.key,
    firstEmail.key,
  );
});

test("failed delivery can retry and concurrent runs send the digest once", async () => {
  const sender = await createSender();
  await createEnvelope(sender.id, "Renewal");

  const keys: (string | undefined)[] = [];
  const emailService: EmailService = {
    async send(email, options) {
      if (
        email.template === "sender_daily_digest" &&
        email.to === sender.email
      ) {
        keys.push(options?.idempotencyKey);
        if (keys.length === 1) {
          throw new Error("mail queue unavailable");
        }
      }
      return { accepted: [email.to], messageId: "message", rejected: [] };
    },
    async sendBatch() {
      throw new Error("not used");
    },
  };
  const run = () =>
    runEnvelopeSchedule({
      allowSenderDigest,
      database,
      emailService,
      now,
      env,
    });

  const failed = await run();
  assert.deepEqual(failed.senderDigest, {
    failures: [sender.id],
    sent: 0,
    stoppedEarly: false,
  });

  const retried = await Promise.all([run(), run()]);
  assert.equal(
    retried.reduce(
      (total, result) => total + (result.senderDigest?.sent ?? 0),
      0,
    ),
    1,
  );
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
});

test("the digest has its own time budget and reports an incomplete run", async () => {
  const sender = await createSender();
  await createEnvelope(sender.id, "Renewal");
  const messages: string[] = [];
  const emailService: EmailService = {
    async send(email) {
      if (email.template === "sender_daily_digest") messages.push(email.to);
      return { accepted: [email.to], messageId: "message", rejected: [] };
    },
    async sendBatch() {
      throw new Error("not used");
    },
  };
  const schedule = {
    allowSenderDigest,
    database,
    emailService,
    env,
    now,
    timeBudgetMs: 0,
  };

  const incomplete = await runEnvelopeSchedule({
    ...schedule,
    senderDigestTimeBudgetMs: 0,
  });
  assert.equal(incomplete.stoppedEarly, true);
  assert.equal(incomplete.senderDigest?.stoppedEarly, true);
  assert.equal(envelopeScheduleFailed(incomplete), true);
  assert.deepEqual(messages, []);

  const finished = await runEnvelopeSchedule(schedule);
  assert.equal(finished.senderDigest?.stoppedEarly, false);
  assert.equal(envelopeScheduleFailed(finished), false);
  assert.deepEqual(messages, [sender.email]);
});

test("a retention job sends digests only to an authenticated scheduler", async (t) => {
  const sender = await createSender();
  await createEnvelope(sender.id, "Contract");
  const storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-digest-"));
  const messages: string[] = [];
  const options = {
    database,
    emailService: {
      async send(email: TransactionalEmailMessage) {
        if (
          email.template === "sender_daily_digest" &&
          email.to === sender.email
        ) {
          messages.push(email.to);
        }
        return { accepted: [email.to], messageId: "message", rejected: [] };
      },
      async sendBatch() {
        throw new Error("not used");
      },
    },
    storageService: createStorageService({
      env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
    }),
  };
  const previousEnv = Object.entries(env).map(([key, value]) => {
    const previous = process.env[key];
    process.env[key] = value;
    return [key, previous] as const;
  });
  t.after(async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await clearRateLimit("job:retention", { database });
    await rm(storageDir, { force: true, recursive: true });
  });
  await clearRateLimit("job:retention", { database });

  const anonymous = await runRetentionJob({ ...options, caller: "anonymous" });
  assert.equal(anonymous.status, "ran");
  assert.deepEqual(messages, []);
  const authorized = await runRetentionJob({
    ...options,
    caller: "authorized",
  });
  assert.equal(authorized.status, "ran");
  assert.deepEqual(messages, [sender.email]);
});
