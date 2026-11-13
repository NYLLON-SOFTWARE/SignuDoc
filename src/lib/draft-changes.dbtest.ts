import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { afterStatement, openTestDatabase } from "./db/test-database.ts";
import {
  EnvelopeMutationError,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import { createStorageService } from "./services/storage.ts";
import { eraseSignerData } from "./signer-data.ts";

// Two things changing one draft at the same moment, against a real
// Postgres: a save, a send, and a signer erased on request. Each of them
// reads the draft first and writes a moment later, and what it wrote must
// still fit what is there by then. Run with `npm run test:db`.

const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;

let database: pg.Pool;
let workDir: string;
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  database = await openTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-drafts-"));

  // Sending reads its storage and email from the environment.
  for (const name of SETTINGS) {
    settingsBefore.set(name, process.env[name]);
  }

  process.env.APP_URL = "http://localhost:3000";
  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
  process.env.EMAIL_CAPTURE_DIR = path.join(workDir, "outbox");
  process.env.EMAIL_DRIVER = "capture";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = path.join(workDir, "storage");
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();

  for (const [name, value] of settingsBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await rm(workDir, { force: true, recursive: true });
});

function field(signerId: string, type: string, y: number) {
  return {
    height: 0.03,
    page: 1,
    required: true,
    signerId,
    type,
    width: 0.2,
    x: 0.1,
    y,
  };
}

/** A draft ready to send: two signers, a signature field for each. */
async function createDraft() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const sourcePdfKey = `test/${envelopeId}.pdf`;
  const rileyEmail = `riley-${randomUUID()}@example.test`;
  const caseyEmail = `casey-${randomUUID()}@example.test`;

  createdUsers.push(userId);
  await createStorageService().putObject({
    body: new Uint8Array([37, 80, 68, 70]),
    contentType: "application/pdf",
    key: sourcePdfKey,
  });
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Lease', 'draft', $3, 'lease.pdf', 4, 1, $4)
    `,
    [envelopeId, userId, sourcePdfKey, "a".repeat(64)],
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
      signers: [
        { email: rileyEmail, name: "Riley Recipient" },
        { email: caseyEmail, name: "Casey Second" },
      ],
    },
    database,
  );
  const [riley, casey] = saved.signers.map((signer) => signer.id);

  await replaceDraftEnvelopeFields(
    userId,
    envelopeId,
    {
      fields: [
        field(riley!, "signature", 0.1),
        field(casey!, "signature", 0.2),
      ],
    },
    database,
  );

  return {
    casey: casey!,
    caseyEmail,
    envelopeId,
    riley: riley!,
    rileyEmail,
    userId,
  };
}

/** Runs `then` once, the first time the chosen statement has run. */
function onceAfter(
  isTheStatement: (text: string, values: unknown[]) => boolean,
  then: () => Promise<unknown>,
) {
  let done = false;

  return afterStatement(
    database,
    (text, values) => !done && isTheStatement(text, values),
    async () => {
      done = true;
      await then();
    },
  );
}

async function signersOf(envelopeId: string) {
  const result = await database.query<{
    email: string;
    id: string;
    status: string;
  }>(
    `
      select id, email, status from signers
      where envelope_id = $1 order by sign_order
    `,
    [envelopeId],
  );

  return result.rows;
}

async function fieldSignersOf(envelopeId: string) {
  const result = await database.query<{ signer_id: string }>(
    `select signer_id from fields where envelope_id = $1 order by y`,
    [envelopeId],
  );

  return result.rows.map((row) => row.signer_id);
}

async function statusOf(envelopeId: string) {
  const result = await database.query<{ status: string }>(
    `select status from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.status ?? null;
}

async function markSent(envelopeId: string) {
  await database.query(
    `update envelopes set status = 'sent', sent_at = 1 where id = $1`,
    [envelopeId],
  );
}

function refusedWith(statusCode: number, pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof EnvelopeMutationError, String(error));
    assert.equal(error.statusCode, statusCode);
    assert.match(error.message, pattern);
    return true;
  };
}

test("erasing a signer leaves a row that was given someone else's address meanwhile", async () => {
  const draft = await createDraft();
  const newEmail = `jordan-${randomUUID()}@example.test`;

  // Between the erasure's look at who is on which envelope and its delete,
  // the sender replaces Casey with Jordan. The editor keeps the row.
  const result = await eraseSignerData(
    draft.caseyEmail,
    draft.caseyEmail,
    onceAfter(
      (text, values) =>
        text.includes("WHERE lower(s.email) = $1") &&
        values[0] === draft.caseyEmail,
      () =>
        replaceDraftEnvelopeSigners(
          draft.userId,
          draft.envelopeId,
          {
            signers: [
              { email: draft.rileyEmail, id: draft.riley, name: "Riley" },
              { email: newEmail, id: draft.casey, name: "Jordan Third" },
            ],
          },
          database,
        ),
    ),
  );

  // Jordan never asked for anything to be erased.
  assert.deepEqual(
    (await signersOf(draft.envelopeId)).map((signer) => signer.email),
    [draft.rileyEmail, newEmail],
  );
  assert.deepEqual(await fieldSignersOf(draft.envelopeId), [
    draft.riley,
    draft.casey,
  ]);
  assert.deepEqual(result, {
    deletedEnvelopes: 0,
    removedFromDrafts: 0,
    skippedInProgress: [],
  });
});

test("erasing a signer takes them off a draft, with their fields", async () => {
  const draft = await createDraft();

  const result = await eraseSignerData(
    draft.caseyEmail,
    draft.caseyEmail,
    database,
  );

  assert.equal(result.removedFromDrafts, 1);
  assert.deepEqual(
    (await signersOf(draft.envelopeId)).map((signer) => signer.email),
    [draft.rileyEmail],
  );
  assert.deepEqual(await fieldSignersOf(draft.envelopeId), [draft.riley]);
});

test("an envelope is not sent without a signer who was erased while it was being sent", async () => {
  const draft = await createDraft();

  // The send has read and checked two signers. Before it marks the
  // envelope as sent, Casey is erased.
  const outcome = await sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    {
      database: onceAfter(
        (text, values) =>
          text.includes("FROM fields") && values[0] === draft.envelopeId,
        () => eraseSignerData(draft.caseyEmail, draft.caseyEmail, database),
      ),
    },
  ).then(
    () => "sent",
    (error: unknown) => error,
  );

  // Nothing went out: the sender reviewed two signers and one is left.
  assert.equal(
    await statusOf(draft.envelopeId),
    "draft",
    "the envelope went out without the erased signer",
  );
  assert.ok(refusedWith(409, /changed while it was being sent/)(outcome));
  assert.deepEqual(await signersOf(draft.envelopeId), [
    { email: draft.rileyEmail, id: draft.riley, status: "pending" },
  ]);

  const sentEvents = await database.query(
    `select 1 from audit_events where envelope_id = $1 and event = 'sent'`,
    [draft.envelopeId],
  );

  assert.equal(sentEvents.rowCount, 0);
});

test("fields saved for a draft do not land on an envelope that was sent meanwhile", async () => {
  const draft = await createDraft();

  // The save has seen a draft. Before it writes, the envelope goes out.
  await assert.rejects(
    replaceDraftEnvelopeFields(
      draft.userId,
      draft.envelopeId,
      { fields: [field(draft.riley, "signature", 0.5)] },
      onceAfter(
        (text, values) =>
          text.includes("FROM envelope_pages") &&
          values[0] === draft.envelopeId,
        () => markSent(draft.envelopeId),
      ),
    ),
    refusedWith(409, /Only draft envelopes/),
  );

  // What the signers were sent is untouched.
  assert.deepEqual(await fieldSignersOf(draft.envelopeId), [
    draft.riley,
    draft.casey,
  ]);
});

test("signers saved for a draft do not land on an envelope that was sent meanwhile", async () => {
  const draft = await createDraft();

  await assert.rejects(
    replaceDraftEnvelopeSigners(
      draft.userId,
      draft.envelopeId,
      {
        signers: [{ email: draft.rileyEmail, id: draft.riley, name: "Riley" }],
      },
      onceAfter(
        (text, values) =>
          text.includes("AND role = 'cc'") && values[0] === draft.envelopeId,
        () => markSent(draft.envelopeId),
      ),
    ),
    refusedWith(409, /Only draft envelopes/),
  );

  assert.deepEqual(
    (await signersOf(draft.envelopeId)).map((signer) => signer.email),
    [draft.rileyEmail, draft.caseyEmail],
  );
});
