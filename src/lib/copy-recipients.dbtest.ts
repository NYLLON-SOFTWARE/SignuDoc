import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";
import { ZodError } from "zod";

import { openTestDatabase } from "./db/test-database.ts";
import {
  EnvelopeMutationError,
  getDraftSignerStepDataForUser,
  getEnvelopeDetailDataForUser,
  getReviewEnvelopeDataForUser,
  listCopyRecipientsForEnvelopeId,
  replaceDraftEnvelopeSigners,
} from "./envelopes.ts";
import { exportSignerData } from "./signer-data.ts";

// Copy recipients against a real Postgres: they are stored beside the
// signers, and nothing that walks the signing order may see them.
// Run with `npm run test:db`.

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

async function createDraft() {
  const userId = randomUUID();
  const envelopeId = randomUUID();

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
      ) values ($1, $2, 'Lease', 'draft', $3, 'lease.pdf', 10, 1, $4)
    `,
    [envelopeId, userId, `test/${envelopeId}.pdf`, "a".repeat(64)],
  );

  return { envelopeId, userId };
}

const riley = { email: "riley@example.test", name: "Riley Recipient" };
const casey = { email: "casey@example.test", name: "Casey Second" };
const zofia = { email: "zofia@example.test", name: "Zofia Copy" };
const omar = { email: "omar@example.test", name: "Omar Copy" };

async function storedRows(envelopeId: string) {
  const result = await database.query<{
    email: string;
    role: string;
    sign_order: number;
    status: string;
  }>(
    `
      select email, role, sign_order, status from signers
      where envelope_id = $1 order by sign_order
    `,
    [envelopeId],
  );

  return result.rows;
}

test("copy recipients are saved beside the signers and stay out of the signing order", async () => {
  const { envelopeId, userId } = await createDraft();
  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    { copyRecipients: [zofia, omar], signers: [riley, casey] },
    database,
  );

  assert.deepEqual(
    saved.signers.map((signer) => [signer.email, signer.signOrder]),
    [
      [riley.email, 1],
      [casey.email, 2],
    ],
  );
  assert.deepEqual(
    saved.copyRecipients.map((recipient) => recipient.email),
    [zofia.email, omar.email],
  );
  assert.deepEqual(
    (await storedRows(envelopeId)).map((row) => [row.email, row.role]),
    [
      [riley.email, "signer"],
      [casey.email, "signer"],
      [zofia.email, "cc"],
      [omar.email, "cc"],
    ],
  );

  // Every screen that lists signers lists the two signers only.
  const step = await getDraftSignerStepDataForUser(
    userId,
    envelopeId,
    database,
  );
  const review = await getReviewEnvelopeDataForUser(
    userId,
    envelopeId,
    database,
  );
  const detail = await getEnvelopeDetailDataForUser(
    userId,
    envelopeId,
    database,
  );

  for (const view of [step, review, detail]) {
    assert.deepEqual(
      view?.signers.map((signer) => signer.email),
      [riley.email, casey.email],
    );
    assert.deepEqual(
      view?.copyRecipients.map((recipient) => recipient.email),
      [zofia.email, omar.email],
    );
  }
});

test("saving the signers again keeps, replaces or removes the copy recipients", async () => {
  const { envelopeId, userId } = await createDraft();
  const first = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    { copyRecipients: [zofia], signers: [riley] },
    database,
  );
  const zofiaId = first.copyRecipients[0]!.id;

  // A request that does not mention copies leaves them alone, even when
  // the signers are reordered around them.
  await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    { signers: [casey, { ...riley, id: first.signers[0]!.id }] },
    database,
  );
  assert.deepEqual(
    await listCopyRecipientsForEnvelopeId(envelopeId, database),
    [{ ...zofia, id: zofiaId }],
  );

  // Naming them keeps the ones that carry their id and replaces the rest.
  const replaced = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      copyRecipients: [omar, { ...zofia, id: zofiaId, name: "Zofia Renamed" }],
      signers: [riley],
    },
    database,
  );

  assert.deepEqual(
    replaced.copyRecipients.map((recipient) => [
      recipient.name,
      recipient.id === zofiaId,
    ]),
    [
      ["Omar Copy", false],
      ["Zofia Renamed", true],
    ],
  );

  await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    { copyRecipients: [], signers: [riley] },
    database,
  );
  assert.deepEqual(
    (await storedRows(envelopeId)).map((row) => row.email),
    [riley.email],
  );
});

test("one address cannot be both a signer and a copy recipient", async () => {
  const { envelopeId, userId } = await createDraft();

  await assert.rejects(
    replaceDraftEnvelopeSigners(
      userId,
      envelopeId,
      {
        copyRecipients: [{ ...riley, email: "RILEY@example.test" }],
        signers: [riley],
      },
      database,
    ),
    ZodError,
  );
  await assert.rejects(
    replaceDraftEnvelopeSigners(
      userId,
      envelopeId,
      { copyRecipients: [zofia, zofia], signers: [riley] },
      database,
    ),
    ZodError,
  );

  await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    { copyRecipients: [zofia], signers: [riley] },
    database,
  );

  // Signers only, and one of them is already down for a copy.
  await assert.rejects(
    replaceDraftEnvelopeSigners(
      userId,
      envelopeId,
      { signers: [riley, zofia] },
      database,
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 400,
  );
  assert.deepEqual(
    (await storedRows(envelopeId)).map((row) => [row.email, row.role]),
    [
      [riley.email, "signer"],
      [zofia.email, "cc"],
    ],
  );
});

test("one saved copy recipient named twice is refused, and nothing is lost", async () => {
  const { envelopeId, userId } = await createDraft();
  const first = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    { copyRecipients: [zofia], signers: [riley] },
    database,
  );
  const zofiaId = first.copyRecipients[0]!.id;

  // Two rows of the request claim to be the same saved recipient. Their
  // addresses differ, so the check on addresses does not catch it.
  await assert.rejects(
    replaceDraftEnvelopeSigners(
      userId,
      envelopeId,
      {
        copyRecipients: [
          { ...zofia, id: zofiaId },
          { ...omar, id: zofiaId },
        ],
        signers: [riley],
      },
      database,
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      error.statusCode === 400 &&
      /copy recipient/i.test(error.message),
  );
  assert.deepEqual(
    await listCopyRecipientsForEnvelopeId(envelopeId, database),
    [{ ...zofia, id: zofiaId }],
  );
});

test("the database refuses to put a copy recipient into the signing order", async () => {
  const { envelopeId, userId } = await createDraft();

  await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    { copyRecipients: [zofia], signers: [riley] },
    database,
  );

  await assert.rejects(
    database.query(
      `update signers set status = 'notified' where envelope_id = $1 and role = 'cc'`,
      [envelopeId],
    ),
    /signers_copy_recipient_never_signs/,
  );
  await assert.rejects(
    database.query(
      `update signers set signing_token_hash = $2 where envelope_id = $1 and role = 'cc'`,
      [envelopeId, "b".repeat(64)],
    ),
    /signers_copy_recipient_never_signs/,
  );
});

test("a data request for an address finds the envelopes it was copied on", async () => {
  const { envelopeId, userId } = await createDraft();
  const email = `${randomUUID()}@example.test`;

  await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    { copyRecipients: [{ email, name: "Copied Person" }], signers: [riley] },
    database,
  );

  const exported = await exportSignerData(email, database);

  assert.equal(exported.envelopes.length, 1);
  assert.equal(exported.envelopes[0]?.role, "cc");
});
