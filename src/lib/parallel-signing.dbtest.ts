import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { afterStatement, openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import {
  EnvelopeMutationError,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import { sendAutomaticEnvelopeReminder } from "./reminders.ts";
import { verifyAuditChain } from "./services/audit.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { saveSettings } from "./settings.ts";
import {
  declineSigningForToken,
  getSigningPayloadForToken,
  recordSignerConsent,
  submitSigningForToken,
} from "./signing.ts";

// Signing at the same time, against a real Postgres: signers who share a
// step of the signing order are invited together, the next step waits for
// all of them, and two of them submitting at the same moment still move
// the order on, or finish the envelope, exactly once. Run with
// `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;

// A PNG of one transparent pixel, standing in for a drawn signature.
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let database: pg.Pool;
let workDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-parallel-"));
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: path.join(workDir, "outbox"),
    EMAIL_DRIVER: "capture",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: workDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(workDir, { force: true, recursive: true });
});

type Party = {
  fieldId: string;
  id: string;
  name: string;
  token: string | null;
};

/**
 * An envelope out for signature whose signers are in the given steps, in
 * list order: [1, 1, 2] is two signers at the same time, then a third. The
 * first step's signers are waiting with a link each and have agreed to
 * electronic records; the rest are pending.
 */
async function createSteppedEnvelope(steps: readonly number[]) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const sourcePdf = await PDFDocument.create();

  sourcePdf.addPage([612, 792]);

  const sourcePdfBytes = await sourcePdf.save();
  const sourcePdfKey = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: sourcePdfBytes,
    contentType: "application/pdf",
    key: sourcePdfKey,
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
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at, expires_at,
        reminder_interval_days
      ) values ($1, $2, 'Contract', 'sent', $3, 'contract.pdf', $4, 1, $5, $6, $7, 1)
    `,
    [
      envelopeId,
      userId,
      sourcePdfKey,
      sourcePdfBytes.length,
      createHash("sha256").update(sourcePdfBytes).digest("hex"),
      now,
      now + 30 * DAY,
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const parties: Party[] = [];

  for (const [index, step] of steps.entries()) {
    const id = randomUUID();
    const fieldId = randomUUID();
    const waiting = step === steps[0];
    const link = waiting
      ? await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now })
      : null;
    const name = `Signer ${String(index + 1)}`;

    await database.query(
      `
        insert into signers (
          id, envelope_id, name, email, sign_order, signing_step, status,
          signing_token_hash, signing_token_expires_at, turn_started_at,
          last_notified_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      `,
      [
        id,
        envelopeId,
        name,
        `${id}@example.test`,
        index + 1,
        step,
        waiting ? "notified" : "pending",
        link?.tokenHash ?? null,
        link?.exp ?? null,
        waiting ? now - 2 * DAY : null,
      ],
    );
    await database.query(
      `
        insert into fields (
          id, envelope_id, signer_id, type, page, x, y, width, height
        ) values ($1, $2, $3, 'signature', 1, 0.1, $4, 0.2, 0.05)
      `,
      [fieldId, envelopeId, id, 0.1 + index * 0.06],
    );

    if (link) {
      await recordSignerConsent(
        link.token,
        { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
        { database },
      );
    }

    parties.push({ fieldId, id, name, token: link?.token ?? null });
  }

  return { envelopeId, parties, sourcePdfKey, userId };
}

/**
 * Gives a signer whose turn has come a link this test knows, the way the
 * invitation's link would be opened, and has them agree to electronic
 * records.
 */
async function takeOverLink(party: Party) {
  const now = Math.floor(Date.now() / 1000);
  const link = await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now });
  const updated = await database.query(
    `
      update signers
      set signing_token_hash = $1, signing_token_expires_at = $2
      where id = $3 and status = 'notified'
    `,
    [link.tokenHash, link.exp, party.id],
  );

  assert.equal(updated.rowCount, 1, `${party.name} is not waiting`);
  await recordSignerConsent(
    link.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );
  party.token = link.token;
}

function sign(party: Party, pool: pg.Pool = database) {
  assert.ok(party.token, `${party.name} has no link`);

  return submitSigningForToken(
    party.token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: party.fieldId,
          imageDataUrl: DRAWN_SIGNATURE,
          inputMethod: "drawn",
          type: "signature",
        },
      ],
    },
    { database: pool },
  );
}

async function statusesOf(envelopeId: string) {
  const result = await database.query<{ status: string }>(
    `
      select status from signers
      where envelope_id = $1 and role = 'signer'
      order by sign_order
    `,
    [envelopeId],
  );

  return result.rows.map((row) => row.status);
}

async function envelopeStatusOf(envelopeId: string) {
  const result = await database.query<{ status: string }>(
    `select status from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.status;
}

async function countEvents(envelopeId: string, event: string) {
  const result = await database.query<{ count: number }>(
    `
      select count(*)::int as count from audit_events
      where envelope_id = $1 and event = $2
    `,
    [envelopeId, event],
  );

  return result.rows[0]?.count ?? 0;
}

async function invitationsTo(envelopeId: string, signerId: string) {
  const result = await database.query<{ count: number }>(
    `
      select count(*)::int as count from audit_events
      where envelope_id = $1
        and event = 'email_sent'
        and metadata->>'template' = 'signing_invitation'
        and metadata->>'signerId' = $2
    `,
    [envelopeId, signerId],
  );

  return result.rows[0]?.count ?? 0;
}

type CapturedMail = {
  attachments?: { filename: string; sha256: string }[];
  template: string;
  to: string[];
  text: string;
};

async function mailForSender(userId: string) {
  const outbox = path.join(workDir, "outbox");
  const messages = await Promise.all(
    (await readdir(outbox))
      .filter((file) => file.endsWith(".json"))
      .map(
        async (file) =>
          JSON.parse(
            await readFile(path.join(outbox, file), "utf8"),
          ) as CapturedMail,
      ),
  );
  return messages.filter((mail) => mail.to.includes(`${userId}@example.test`));
}

function enableSenderEmail(t: TestContext, key: string) {
  const previous = process.env[key];
  process.env[key] = "1";
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

/** Resolves once another session is held up behind a lock, or `isOver()`. */
async function waitForLockWaiter(isOver: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (isOver()) {
      return;
    }

    const waiting = await database.query(
      `
        select 1
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
        limit 1
      `,
    );

    if (waiting.rowCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Nothing came to wait for the envelope.");
}

/**
 * The same database, except that `start()` gets under way right after the
 * one using it has written its signer's `status = 'signed'`, and before it
 * commits: what `start()` began read the envelope while the first signature
 * was not yet saved, and has to wait for the envelope's row.
 */
function withRivalAfterSignature(start: () => Promise<unknown>) {
  const started: { rival?: Promise<unknown> } = {};
  const pool = afterStatement(
    database,
    (text) => !started.rival && text.includes("status = 'signed'"),
    async () => {
      let over = false;
      const rival = start();

      rival.then(
        () => {
          over = true;
        },
        () => {
          over = true;
        },
      );
      started.rival = rival;
      await waitForLockWaiter(() => over);
    },
  );

  return { pool, started };
}

test("signers of one step are invited together, and the next step waits for all of them", async () => {
  const envelope = await createSteppedEnvelope([1, 1, 2]);
  const [first, second, third] = envelope.parties as [Party, Party, Party];

  await sign(first);

  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "signed",
    "notified",
    "pending",
  ]);
  assert.equal(await invitationsTo(envelope.envelopeId, third.id), 0);

  await sign(second);

  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "signed",
    "signed",
    "notified",
  ]);
  assert.equal(await invitationsTo(envelope.envelopeId, third.id), 1);
  assert.equal(await envelopeStatusOf(envelope.envelopeId), "sent");

  await takeOverLink(third);
  await sign(third);

  assert.equal(await envelopeStatusOf(envelope.envelopeId), "completed");
  assert.equal(await countEvents(envelope.envelopeId, "signed"), 3);
  assert.equal(await countEvents(envelope.envelopeId, "completed"), 1);
  assert.equal(
    (await verifyAuditChain(envelope.envelopeId, database)).ok,
    true,
  );
});

test("the sender receives one first-open alert and one progress alert without a signing link", async (t) => {
  enableSenderEmail(t, "SIGNUDOC_EMAIL_SENDER_ACTIVITY");

  const { envelopeId, parties, userId } = await createSteppedEnvelope([1, 2]);
  const [first] = parties;
  assert.ok(first?.token);
  const token = first.token;
  await database.query(
    `update public."user" set "emailVerified" = true where id = $1`,
    [userId],
  );

  await Promise.all(
    Array.from({ length: 4 }, () =>
      getSigningPayloadForToken(token, { database }),
    ),
  );
  await sign(first);

  const events = ["sender_signer_viewed", "sender_signer_signed"];
  let messages: CapturedMail[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    messages = (await mailForSender(userId)).filter((mail) =>
      events.includes(mail.template),
    );
    if (messages.length >= events.length) break;
    await delay(50);
  }

  assert.deepEqual(
    messages.map((mail) => mail.template).sort(),
    [...events].sort(),
  );
  for (const mail of messages) {
    assert.deepEqual(mail.to, [`${userId}@example.test`]);
    assert.ok(mail.text.includes(first.name));
    assert.ok(mail.text.includes(`/envelopes/${envelopeId}`));
    assert.ok(!mail.text.includes(token));
  }
  assert.equal(await countEvents(envelopeId, "viewed"), 1);
});

test("sender completion attaches only the signed PDF for a verified owner", async (t) => {
  enableSenderEmail(t, "SIGNUDOC_EMAIL_SENDER_COMPLETION_ATTACHMENTS");

  for (const verified of [true, false]) {
    const { envelopeId, parties, userId } = await createSteppedEnvelope([1]);
    const [signer] = parties as [Party];
    await database.query(
      `update public."user" set "emailVerified" = $2 where id = $1`,
      [userId, verified],
    );
    await sign(signer);

    const [completion] = (await mailForSender(userId)).filter(
      (mail) => mail.template === "completion_notification",
    );
    assert.ok(completion);
    assert.ok(completion.text.includes(`/envelopes/${envelopeId}`));
    const { rows } = await database.query<{ sha: string }>(
      "select signed_pdf_sha256 as sha from envelopes where id = $1",
      [envelopeId],
    );
    const attachments = completion.attachments ?? [];
    assert.equal(attachments.length, verified ? 1 : 0);
    if (verified) {
      assert.equal(attachments[0]?.filename, "Contract - signed.pdf");
      assert.equal(attachments[0]?.sha256, rows[0]?.sha);
    }
  }
});

test("a step's signers start the next step together when it has several", async () => {
  const envelope = await createSteppedEnvelope([1, 2, 2]);
  const [first, second, third] = envelope.parties as [Party, Party, Party];

  await sign(first);

  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "signed",
    "notified",
    "notified",
  ]);
  assert.equal(await invitationsTo(envelope.envelopeId, second.id), 1);
  assert.equal(await invitationsTo(envelope.envelopeId, third.id), 1);
});

test("two signers of the last step who submit at the same moment finish the envelope once", async () => {
  const envelope = await createSteppedEnvelope([1, 1]);
  const [first, second] = envelope.parties as [Party, Party];
  // The second signer reads the envelope while the first signature is
  // written but not saved, so takes it for one that is not the last, and
  // only learns otherwise once it holds the envelope.
  const { pool, started } = withRivalAfterSignature(() => sign(second));

  await sign(first, pool);

  assert.ok(started.rival, "the first signature was never written");
  await started.rival;

  assert.deepEqual(await statusesOf(envelope.envelopeId), ["signed", "signed"]);
  assert.equal(await envelopeStatusOf(envelope.envelopeId), "completed");
  assert.equal(await countEvents(envelope.envelopeId, "signed"), 2);
  assert.equal(await countEvents(envelope.envelopeId, "completed"), 1);
  assert.equal(
    (await verifyAuditChain(envelope.envelopeId, database)).ok,
    true,
  );

  const row = await database.query<{
    signed_pdf_key: string | null;
    signed_pdf_sha256: string | null;
  }>(`select signed_pdf_key, signed_pdf_sha256 from envelopes where id = $1`, [
    envelope.envelopeId,
  ]);
  const stored = row.rows[0]!;

  assert.ok(stored.signed_pdf_key);
  assert.equal(
    createHash("sha256")
      .update((await storageService.getObject(stored.signed_pdf_key)).body)
      .digest("hex"),
    stored.signed_pdf_sha256,
  );
});

test("two signers of a middle step who submit at the same moment invite the next step once", async () => {
  const envelope = await createSteppedEnvelope([1, 1, 2]);
  const [first, second, third] = envelope.parties as [Party, Party, Party];
  const { pool, started } = withRivalAfterSignature(() => sign(second));

  await sign(first, pool);

  assert.ok(started.rival, "the first signature was never written");
  await started.rival;

  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "signed",
    "signed",
    "notified",
  ]);
  assert.equal(await envelopeStatusOf(envelope.envelopeId), "sent");
  assert.equal(await invitationsTo(envelope.envelopeId, third.id), 1);
  assert.equal(
    (await verifyAuditChain(envelope.envelopeId, database)).ok,
    true,
  );
});

test("a decline while another signer of the step signs starts again from that signature", async () => {
  const envelope = await createSteppedEnvelope([1, 1, 2]);
  const [first, second] = envelope.parties as [Party, Party, Party];
  const { pool, started } = withRivalAfterSignature(() =>
    declineSigningForToken(
      second.token!,
      { reason: "Not this one." },
      {
        database,
      },
    ),
  );

  await sign(first, pool);

  assert.ok(started.rival, "the signature was never written");
  await started.rival;

  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "signed",
    "declined",
    "pending",
  ]);
  assert.equal(await envelopeStatusOf(envelope.envelopeId), "declined");

  // The signature that came first is in the trail before the decline.
  const events = await database.query<{ event: string }>(
    `
      select event from audit_events
      where envelope_id = $1 and event in ('signed', 'declined')
      order by sequence
    `,
    [envelope.envelopeId],
  );

  assert.deepEqual(
    events.rows.map((row) => row.event),
    ["signed", "declined"],
  );
  assert.equal(
    (await verifyAuditChain(envelope.envelopeId, database)).ok,
    true,
  );
});

test("an automatic reminder reaches every waiting signer of the step", async () => {
  const envelope = await createSteppedEnvelope([1, 1, 2]);

  assert.equal(
    await sendAutomaticEnvelopeReminder(envelope.envelopeId, { database }),
    true,
  );
  assert.equal(await countEvents(envelope.envelopeId, "reminded_auto"), 2);
});

/** A draft with three signers, each with a signature field. */
async function createDraft(steps: readonly number[] | null) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const sourcePdf = await PDFDocument.create();

  sourcePdf.addPage([612, 792]);

  const sourcePdfBytes = await sourcePdf.save();
  const sourcePdfKey = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: sourcePdfBytes,
    contentType: "application/pdf",
    key: sourcePdfKey,
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
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Contract', 'draft', $3, 'contract.pdf', $4, 1, $5)
    `,
    [
      envelopeId,
      userId,
      sourcePdfKey,
      sourcePdfBytes.length,
      createHash("sha256").update(sourcePdfBytes).digest("hex"),
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      signers: ["Ann", "Bob", "Cy"].map((name, index) => ({
        email: `${name.toLowerCase()}-${randomUUID()}@example.test`,
        name,
        ...(steps ? { signingStep: steps[index] } : {}),
      })),
    },
    database,
  );

  await replaceDraftEnvelopeFields(
    userId,
    envelopeId,
    {
      fields: saved.signers.map((signer, index) => ({
        height: 0.05,
        page: 1,
        required: true,
        signerId: signer.id,
        type: "signature",
        width: 0.2,
        x: 0.1,
        y: 0.1 + index * 0.1,
      })),
    },
    database,
  );

  return { envelopeId, saved, userId };
}

test("saved steps are renumbered, and a list without steps signs in order", async () => {
  const stepped = await createDraft([5, 5, 9]);

  assert.deepEqual(
    stepped.saved.signers.map((signer) => [
      signer.signOrder,
      signer.signingStep,
    ]),
    [
      [1, 1],
      [2, 1],
      [3, 2],
    ],
  );

  const plain = await createDraft(null);

  assert.deepEqual(
    plain.saved.signers.map((signer) => [signer.signOrder, signer.signingStep]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  );

  await assert.rejects(
    replaceDraftEnvelopeSigners(
      stepped.userId,
      stepped.envelopeId,
      {
        signers: [
          { email: "a@example.test", name: "A", signingStep: 2 },
          { email: "b@example.test", name: "B", signingStep: 1 },
        ],
      },
      database,
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 400,
  );
});

test("sending invites everyone in the first step", async () => {
  const draft = await createDraft([1, 1, 2]);
  const sent = await sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    { database },
  );

  assert.match(sent.notifiedSignerName, /Ann and Bob/);
  assert.deepEqual(await statusesOf(draft.envelopeId), [
    "notified",
    "notified",
    "pending",
  ]);

  for (const signer of draft.saved.signers.slice(0, 2)) {
    assert.equal(await invitationsTo(draft.envelopeId, signer.id), 1);
  }

  const tokens = await database.query<{ hash: string | null }>(
    `
      select signing_token_hash as hash from signers
      where envelope_id = $1 and status = 'notified'
    `,
    [draft.envelopeId],
  );

  assert.equal(new Set(tokens.rows.map((row) => row.hash)).size, 2);
});

test("advanced or qualified signatures are not sent to signers at the same time", async () => {
  const draft = await createDraft([1, 1, 2]);

  await assert.rejects(
    sendDraftEnvelope(
      draft.userId,
      draft.envelopeId,
      {
        senderEmail: "sam@example.test",
        senderName: "Sam Sender",
        signatureLevel: "advanced",
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      error.statusCode === 400 &&
      /one after another/.test(error.message),
  );
  assert.equal(await envelopeStatusOf(draft.envelopeId), "draft");
});

test("when a later first-step invitation fails, the sender is not told that person was invited", async () => {
  const draft = await createDraft([1, 1, 2]);
  const bob = draft.saved.signers[1]!;
  // The capture email driver writes each message to a file; making that
  // write fail for Bob's invitation alone stands in for a failed send.
  const require = createRequire(import.meta.url);
  const fsPromises = require("node:fs/promises") as {
    writeFile: (...args: unknown[]) => Promise<unknown>;
  };
  const realWriteFile = fsPromises.writeFile;

  fsPromises.writeFile = (...args: unknown[]) =>
    String(args[1]).includes(bob.email)
      ? Promise.reject(new Error("mail refused"))
      : realWriteFile(...args);
  syncBuiltinESMExports();

  const originalError = console.error;

  console.error = () => undefined;

  try {
    const sent = await sendDraftEnvelope(
      draft.userId,
      draft.envelopeId,
      { senderEmail: "sam@example.test", senderName: "Sam Sender" },
      { database },
    );

    assert.match(sent.notifiedSignerName, /Ann/);
    assert.doesNotMatch(sent.notifiedSignerName, /Bob/);
  } finally {
    console.error = originalError;
    fsPromises.writeFile = realWriteFile;
    syncBuiltinESMExports();
  }
});

test("qualified signatures are not sent to signers at the same time either", async () => {
  const draft = await createDraft([1, 1, 2]);

  await assert.rejects(
    sendDraftEnvelope(
      draft.userId,
      draft.envelopeId,
      {
        senderEmail: "sam@example.test",
        senderName: "Sam Sender",
        signatureLevel: "qualified",
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      error.statusCode === 400 &&
      /one after another/.test(error.message),
  );
  assert.equal(await envelopeStatusOf(draft.envelopeId), "draft");
});

test("Part 11 envelopes are not sent to signers at the same time", async () => {
  const draft = await createDraft([1, 1, 2]);

  await saveSettings({ part11Mode: true }, database);

  try {
    await assert.rejects(
      sendDraftEnvelope(
        draft.userId,
        draft.envelopeId,
        { senderEmail: "sam@example.test", senderName: "Sam Sender" },
        { database },
      ),
      (error: unknown) =>
        error instanceof EnvelopeMutationError &&
        error.statusCode === 400 &&
        /Part 11 mode signs one signer after another/.test(error.message),
    );
  } finally {
    await saveSettings({ part11Mode: false }, database);
  }

  assert.equal(await envelopeStatusOf(draft.envelopeId), "draft");
});
