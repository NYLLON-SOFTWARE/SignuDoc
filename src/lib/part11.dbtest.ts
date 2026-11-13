import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { eraseSignerData } from "./signer-data.ts";
import {
  checkSigningCredentials,
  MAX_SIGNING_PASSWORD_ATTEMPTS,
  type PasswordVerifier,
} from "./part11.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import {
  recordSystemAuditEvent,
  verifySystemAuditChain,
} from "./services/system-audit.ts";

// Part 11 mode against a real Postgres: the install audit chain and the
// password check at signing, with its lock after five wrong passwords.
// Run with `npm run test:db`.

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.query(`delete from account where "userId" = any($1)`, [
    createdUsers,
  ]);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

async function createUser(role: "admin" | "user" = "user") {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (
        id, name, email, role, "emailVerified", identity_verified_at
      ) values ($1, $2, $3, $4, true, 1)
    `,
    [id, `Person ${id.slice(0, 4)}`, `${id}@example.test`, role],
  );
  await database.query(
    `
      insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
      values ($1, $2, 'credential', $2, 'stored-hash', now(), now())
    `,
    [randomUUID(), id],
  );

  return { email: `${id}@example.test`, id };
}

// The real check runs Better Auth's hash. Here the stored hash is a stand-in
// and only "right" passes.
const verifyPassword: PasswordVerifier = async ({ hash, password }) =>
  hash === "stored-hash" && password === "right";

function recordingEmailService() {
  const sent: TransactionalEmailMessage[] = [];
  const service: EmailService = {
    async send(message) {
      sent.push(message);
      return { accepted: [message.to], messageId: "m-1", rejected: [] };
    },
    async sendBatch() {
      throw new Error("not used");
    },
  };

  return { sent, service };
}

test("the install audit trail is one hash chain that shows a changed row", async () => {
  const before = await verifySystemAuditChain(database);

  assert.equal(before.ok, true);

  const first = await recordSystemAuditEvent(
    {
      actorEmail: "a@example.test",
      event: "settings_changed",
      metadata: { changes: { x: 1 } },
    },
    database,
  );
  const second = await recordSystemAuditEvent(
    {
      actorEmail: "a@example.test",
      event: "part11_mode_changed",
      metadata: { to: true },
    },
    database,
  );

  assert.equal(second.sequence, first.sequence + 1);
  assert.deepEqual(await verifySystemAuditChain(database), {
    events: before.events + 2,
    ok: true,
  });

  await database.query(
    `update system_audit_events set metadata = '{"to": false}' where id = $1`,
    [second.id],
  );

  try {
    assert.deepEqual(await verifySystemAuditChain(database), {
      brokenAtSequence: second.sequence,
      events: before.events + 2,
      ok: false,
    });
  } finally {
    await database.query(
      `update system_audit_events set metadata = '{"to": true}' where id = $1`,
      [second.id],
    );
  }

  assert.equal((await verifySystemAuditChain(database)).ok, true);
});

test("a right password signs and clears earlier misses", async () => {
  const user = await createUser();
  const options = { database, verifyPassword };

  assert.deepEqual(
    await checkSigningCredentials(
      { email: user.email, password: "wrong", userId: user.id },
      options,
    ),
    {
      attemptsLeft: MAX_SIGNING_PASSWORD_ATTEMPTS - 1,
      locked: false,
      ok: false,
    },
  );
  assert.deepEqual(
    await checkSigningCredentials(
      { email: user.email.toUpperCase(), password: "right", userId: user.id },
      options,
    ),
    { ok: true },
  );

  const row = await database.query(
    `select signing_failed_attempts from "user" where id = $1`,
    [user.id],
  );

  assert.equal(row.rows[0].signing_failed_attempts, 0);
});

test("a right password with someone else's email address is a miss", async () => {
  const user = await createUser();

  assert.equal(
    (
      await checkSigningCredentials(
        { email: "other@example.test", password: "right", userId: user.id },
        { database, verifyPassword },
      )
    ).ok,
    false,
  );
});

test("five wrong passwords lock signing, tell the administrators and are audited", async () => {
  const admin = await createUser("admin");
  const user = await createUser();
  const { sent, service } = recordingEmailService();
  const options = { database, emailService: service, verifyPassword };

  for (
    let attempt = 1;
    attempt <= MAX_SIGNING_PASSWORD_ATTEMPTS;
    attempt += 1
  ) {
    const result = await checkSigningCredentials(
      { email: user.email, password: "wrong", userId: user.id },
      options,
    );

    assert.deepEqual(result, {
      attemptsLeft: MAX_SIGNING_PASSWORD_ATTEMPTS - attempt,
      locked: attempt === MAX_SIGNING_PASSWORD_ATTEMPTS,
      ok: false,
    });
  }

  // Locked: even the right password is refused now.
  assert.deepEqual(
    await checkSigningCredentials(
      { email: user.email, password: "right", userId: user.id },
      options,
    ),
    { attemptsLeft: 0, locked: true, ok: false },
  );

  const alerts = sent.filter(
    (message) => message.template === "signing_lock_alert",
  );

  assert.ok(alerts.some((message) => message.to === admin.email));

  const events = await database.query(
    `
      select event from system_audit_events
      where target_user_id = $1 order by sequence
    `,
    [user.id],
  );

  assert.deepEqual(
    events.rows.map((row) => row.event),
    [
      ...Array(MAX_SIGNING_PASSWORD_ATTEMPTS - 1).fill(
        "reauthentication_failed",
      ),
      "signing_locked",
    ],
  );
  assert.equal((await verifySystemAuditChain(database)).ok, true);
});

test("a data request does not erase a finished Part 11 envelope", async () => {
  const sender = await createUser();
  const envelopeId = randomUUID();
  const signerEmail = `${randomUUID()}@example.test`;

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        completed_at, part11
      ) values ($1, $2, 'Batch record', 'completed', $3, 'batch.pdf', 4, 1,
        $4, 1, 2, true)
    `,
    [envelopeId, sender.id, `test/${envelopeId}.pdf`, "a".repeat(64)],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status, signature_meaning)
      values ($1, $2, 'Signer', $3, 1, 'signed', 'approval')
    `,
    [randomUUID(), envelopeId, signerEmail],
  );

  const result = await eraseSignerData(signerEmail, signerEmail, database);

  assert.equal(result.deletedEnvelopes, 0);
  assert.deepEqual(result.keptPart11, [
    { id: envelopeId, title: "Batch record" },
  ]);

  const kept = await database.query(`select 1 from envelopes where id = $1`, [
    envelopeId,
  ]);

  assert.equal(kept.rowCount, 1);
  await database.query(`delete from envelopes where id = $1`, [envelopeId]);
});

test("an identity confirmation taken back after send stops the signature", async () => {
  const user = await createUser();

  await database.query(
    `update "user" set identity_verified_at = null where id = $1`,
    [user.id],
  );

  assert.deepEqual(
    await checkSigningCredentials(
      { email: user.email, password: "right", userId: user.id },
      { database, verifyPassword },
    ),
    {
      attemptsLeft: MAX_SIGNING_PASSWORD_ATTEMPTS,
      identityNotConfirmed: true,
      locked: false,
      ok: false,
    },
  );
});
