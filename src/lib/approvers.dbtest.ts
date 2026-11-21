import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { afterStatement, openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import {
  EnvelopeMutationError,
  getReviewEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import { verifyAuditChain } from "./services/audit.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  approveSigningForToken,
  declineSigningForToken,
  getSigningPayloadForToken,
  recordSignerConsent,
  SigningMutationError,
  submitSigningForToken,
} from "./signing.ts";

// Approvers, against a real Postgres: an approver takes part in the steps
// of the signing order like a signer, approves without fields, is recorded
// as "approved" and never as "signed", and a rejection ends the envelope
// like a decline. An approver and a signer of one step who finish at the
// same moment move the order on, or finish the envelope, exactly once,
// under the same locking as two signers (parallel-signing.dbtest.ts).
// Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let database: pg.Pool;
let workDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-approvers-"));
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
  fieldId: string | null;
  id: string;
  name: string;
  role: "approver" | "signer";
  token: string | null;
};

async function storeSourcePdf(envelopeId: string) {
  const sourcePdf = await PDFDocument.create();

  sourcePdf.addPage([612, 792]);

  const bytes = await sourcePdf.save();
  const key = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: bytes,
    contentType: "application/pdf",
    key,
  });

  return {
    bytes,
    hash: createHash("sha256").update(bytes).digest("hex"),
    key,
  };
}

async function createSender() {
  const userId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );

  return userId;
}

/**
 * An envelope out for signature with these people in these steps, in list
 * order. Approvers have no fields. The first step is waiting, with a link
 * each, and has agreed to electronic records.
 */
async function createEnvelope(
  people: ReadonlyArray<{ role: "approver" | "signer"; step: number }>,
) {
  const userId = await createSender();
  const envelopeId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const source = await storeSourcePdf(envelopeId);

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at, expires_at
      ) values ($1, $2, 'Contract', 'sent', $3, 'contract.pdf', $4, 1, $5, $6, $7)
    `,
    [
      envelopeId,
      userId,
      source.key,
      source.bytes.length,
      source.hash,
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
  const firstStep = Math.min(...people.map((person) => person.step));

  for (const [index, person] of people.entries()) {
    const id = randomUUID();
    const waiting = person.step === firstStep;
    const link = waiting
      ? await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now })
      : null;
    const name = `${person.role === "approver" ? "Approver" : "Signer"} ${String(index + 1)}`;

    await database.query(
      `
        insert into signers (
          id, envelope_id, name, email, sign_order, signing_step, status,
          signing_token_hash, signing_token_expires_at, turn_started_at,
          last_notified_at, role
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
      `,
      [
        id,
        envelopeId,
        name,
        `${id}@example.test`,
        index + 1,
        person.step,
        waiting ? "notified" : "pending",
        link?.tokenHash ?? null,
        link?.exp ?? null,
        waiting ? now : null,
        person.role,
      ],
    );

    let fieldId: string | null = null;

    if (person.role === "signer") {
      fieldId = randomUUID();
      await database.query(
        `
          insert into fields (
            id, envelope_id, signer_id, type, page, x, y, width, height
          ) values ($1, $2, $3, 'signature', 1, 0.1, $4, 0.2, 0.05)
        `,
        [fieldId, envelopeId, id, 0.1 + index * 0.06],
      );
    }

    if (link) {
      await recordSignerConsent(
        link.token,
        { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
        { database },
      );
    }

    parties.push({
      fieldId,
      id,
      name,
      role: person.role,
      token: link?.token ?? null,
    });
  }

  return { envelopeId, parties, userId };
}

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

/** Signs, or approves, as the party's role says. */
function act(party: Party, pool: pg.Pool = database) {
  assert.ok(party.token, `${party.name} has no link`);

  if (party.role === "approver") {
    return approveSigningForToken(
      party.token,
      { clientTimezoneOffsetMinutes: 0 },
      { database: pool },
    );
  }

  return submitSigningForToken(
    party.token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: party.fieldId!,
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
      where envelope_id = $1 and role in ('signer', 'approver')
      order by sign_order
    `,
    [envelopeId],
  );

  return result.rows.map((row) => row.status);
}

async function envelopeOf(envelopeId: string) {
  const result = await database.query<{
    evidence_key: string | null;
    status: string;
  }>(`select status, evidence_key from envelopes where id = $1`, [envelopeId]);

  return result.rows[0]!;
}

async function eventsOf(envelopeId: string, event: string) {
  const result = await database.query<{
    metadata: Record<string, unknown> | null;
  }>(
    `
      select metadata from audit_events
      where envelope_id = $1 and event = $2
      order by sequence
    `,
    [envelopeId, event],
  );

  return result.rows.map((row) => row.metadata ?? {});
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

async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const parts: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();

    parts.push(
      content.items.map((item: { str?: string }) => item.str ?? "").join(" "),
    );
  }

  await document.destroy();

  return parts.join("\n").replace(/\s+/g, " ");
}

async function storedCertificateText(envelopeId: string) {
  const { evidence_key: key } = await envelopeOf(envelopeId);

  assert.ok(key, "no certificate was stored");

  return extractPdfText((await storageService.getObject(key)).body);
}

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
 * one using it has written its turn as done (`status = 'signed'`), and
 * before it commits.
 */
function withRivalAfterTurn(start: () => Promise<unknown>) {
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

test("the manager approves in step 1, then the customer is invited and signs", async () => {
  const envelope = await createEnvelope([
    { role: "approver", step: 1 },
    { role: "signer", step: 2 },
  ]);
  const [manager, customer] = envelope.parties as [Party, Party];

  // The customer has not been invited while the approval is outstanding.
  assert.equal(await invitationsTo(envelope.envelopeId, customer.id), 0);

  const payload = await getSigningPayloadForToken(manager.token!, {
    database,
  });

  assert.equal(payload.signer.role, "approver");
  assert.equal(payload.currentSignerFields.length, 0);
  assert.ok(payload.approveUrl?.endsWith("/approve"));

  const approved = await act(manager);

  assert.match(approved.redirectPath, /approved=1/);
  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "signed",
    "notified",
  ]);
  assert.equal(await invitationsTo(envelope.envelopeId, customer.id), 1);

  const approvals = await eventsOf(envelope.envelopeId, "approved");

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.role, "approver");
  assert.equal(approvals[0]?.signerId, manager.id);
  // An approval is never recorded as a signature.
  assert.equal((await eventsOf(envelope.envelopeId, "signed")).length, 0);

  await takeOverLink(customer);
  await act(customer);

  assert.equal((await envelopeOf(envelope.envelopeId)).status, "completed");
  assert.equal((await eventsOf(envelope.envelopeId, "signed")).length, 1);
  assert.equal((await eventsOf(envelope.envelopeId, "completed")).length, 1);
  assert.equal(
    (await verifyAuditChain(envelope.envelopeId, database)).ok,
    true,
  );

  const certificate = await storedCertificateText(envelope.envelopeId);

  assert.match(certificate, /Signers and approvers/);
  assert.match(certificate, /Approved by Approver 1/);
  assert.match(certificate, /Approver \| Approved at/);
  assert.match(certificate, /Signer 2 .*\| Signed at/);
});

test("an approval can be the last turn, and finishes the envelope", async () => {
  const envelope = await createEnvelope([
    { role: "signer", step: 1 },
    { role: "approver", step: 2 },
  ]);
  const [customer, approver] = envelope.parties as [Party, Party];

  await act(customer);
  await takeOverLink(approver);
  await act(approver);

  assert.equal((await envelopeOf(envelope.envelopeId)).status, "completed");
  assert.equal((await eventsOf(envelope.envelopeId, "approved")).length, 1);
  assert.equal((await eventsOf(envelope.envelopeId, "completed")).length, 1);
});

test("a rejection ends the envelope like a decline, with its reason, recorded as rejected", async () => {
  const envelope = await createEnvelope([
    { role: "approver", step: 1 },
    { role: "signer", step: 2 },
  ]);
  const [manager, customer] = envelope.parties as [Party, Party];

  await declineSigningForToken(
    manager.token!,
    { reason: "Price is wrong." },
    { database },
  );

  assert.equal((await envelopeOf(envelope.envelopeId)).status, "declined");
  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "declined",
    "pending",
  ]);
  assert.equal(await invitationsTo(envelope.envelopeId, customer.id), 0);

  const rejections = await eventsOf(envelope.envelopeId, "rejected");

  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]?.reason, "Price is wrong.");
  assert.equal((await eventsOf(envelope.envelopeId, "declined")).length, 0);

  const certificate = await storedCertificateText(envelope.envelopeId);

  assert.match(certificate, /Rejected by Approver 1 .*Price is wrong\./);
});

test("an approver's link cannot sign, and a signer's link cannot approve", async () => {
  const envelope = await createEnvelope([
    { role: "approver", step: 1 },
    { role: "signer", step: 1 },
  ]);
  const [approver, signer] = envelope.parties as [Party, Party];

  await assert.rejects(
    submitSigningForToken(
      approver.token!,
      { clientTimezoneOffsetMinutes: 0, fields: [] },
      { database },
    ),
    (error: unknown) =>
      error instanceof SigningMutationError && error.statusCode === 409,
  );
  await assert.rejects(
    approveSigningForToken(
      signer.token!,
      { clientTimezoneOffsetMinutes: 0 },
      { database },
    ),
    (error: unknown) =>
      error instanceof SigningMutationError && error.statusCode === 409,
  );
  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "notified",
    "notified",
  ]);
});

test("an approval is refused on a Part 11 envelope, whatever happened at sending", async () => {
  const envelope = await createEnvelope([
    { role: "approver", step: 1 },
    { role: "signer", step: 2 },
  ]);

  await database.query(`update envelopes set part11 = true where id = $1`, [
    envelope.envelopeId,
  ]);

  await assert.rejects(
    act(envelope.parties[0]!),
    (error: unknown) =>
      error instanceof SigningMutationError && error.statusCode === 409,
  );
  assert.equal((await eventsOf(envelope.envelopeId, "approved")).length, 0);
});

test("an approver and a signer of one step finishing together invite the next step once", async () => {
  const envelope = await createEnvelope([
    { role: "approver", step: 1 },
    { role: "signer", step: 1 },
    { role: "signer", step: 2 },
  ]);
  const [approver, signer, next] = envelope.parties as [Party, Party, Party];
  const { pool, started } = withRivalAfterTurn(() => act(signer));

  await act(approver, pool);

  assert.ok(started.rival, "the approval was never written");
  await started.rival;

  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "signed",
    "signed",
    "notified",
  ]);
  assert.equal(await invitationsTo(envelope.envelopeId, next.id), 1);
  assert.equal(
    (await verifyAuditChain(envelope.envelopeId, database)).ok,
    true,
  );
});

test("an approver and a signer of the last step finishing together complete it once", async () => {
  const envelope = await createEnvelope([
    { role: "signer", step: 1 },
    { role: "approver", step: 1 },
  ]);
  const [signer, approver] = envelope.parties as [Party, Party];
  const { pool, started } = withRivalAfterTurn(() => act(approver));

  await act(signer, pool);

  assert.ok(started.rival, "the signature was never written");
  await started.rival;

  assert.equal((await envelopeOf(envelope.envelopeId)).status, "completed");
  assert.equal((await eventsOf(envelope.envelopeId, "completed")).length, 1);
  assert.equal((await eventsOf(envelope.envelopeId, "approved")).length, 1);
  assert.equal((await eventsOf(envelope.envelopeId, "signed")).length, 1);
});

test("a rejection while a signer of the step signs starts again from that signature", async () => {
  const envelope = await createEnvelope([
    { role: "signer", step: 1 },
    { role: "approver", step: 1 },
    { role: "signer", step: 2 },
  ]);
  const [signer, approver] = envelope.parties as [Party, Party, Party];
  const { pool, started } = withRivalAfterTurn(() =>
    declineSigningForToken(approver.token!, { reason: "No." }, { database }),
  );

  await act(signer, pool);

  assert.ok(started.rival, "the signature was never written");
  await started.rival;

  assert.deepEqual(await statusesOf(envelope.envelopeId), [
    "signed",
    "declined",
    "pending",
  ]);
  assert.equal((await envelopeOf(envelope.envelopeId)).status, "declined");

  // The certificate shows the signature that came first.
  const certificate = await storedCertificateText(envelope.envelopeId);

  assert.match(certificate, /Signer 1 .*\| Signed at/);
  assert.match(certificate, /Rejected by Approver 2/);
});

async function createDraft() {
  const userId = await createSender();
  const envelopeId = randomUUID();
  const source = await storeSourcePdf(envelopeId);

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Contract', 'draft', $3, 'contract.pdf', $4, 1, $5)
    `,
    [envelopeId, userId, source.key, source.bytes.length, source.hash],
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
        {
          email: `boss-${randomUUID()}@example.test`,
          name: "Bea Boss",
          role: "approver",
          signingStep: 1,
        },
        {
          email: `client-${randomUUID()}@example.test`,
          name: "Cal Client",
          role: "signer",
          signingStep: 2,
        },
      ],
    },
    database,
  );
  const [approver, customer] = saved.signers as [
    (typeof saved.signers)[number],
    (typeof saved.signers)[number],
  ];

  return { approver, customer, envelopeId, userId };
}

function signatureField(signerId: string) {
  return {
    height: 0.05,
    page: 1,
    required: true,
    signerId,
    type: "signature" as const,
    width: 0.2,
    x: 0.1,
    y: 0.1,
  };
}

test("an approver is saved with the role, and can have no fields", async () => {
  const draft = await createDraft();

  assert.equal(draft.approver.role, "approver");
  assert.equal(draft.customer.role, "signer");

  await assert.rejects(
    replaceDraftEnvelopeFields(
      draft.userId,
      draft.envelopeId,
      { fields: [signatureField(draft.approver.id)] },
      database,
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 400,
  );

  // And the database refuses one written another way.
  await assert.rejects(
    database.query(
      `
        insert into fields (id, envelope_id, signer_id, type, page, x, y, width, height)
        values ($1, $2, $3, 'signature', 1, 0.1, 0.1, 0.2, 0.05)
      `,
      [randomUUID(), draft.envelopeId, draft.approver.id],
    ),
  );
});

test("sending invites the approver first, with an invitation to approve", async () => {
  const draft = await createDraft();

  await replaceDraftEnvelopeFields(
    draft.userId,
    draft.envelopeId,
    { fields: [signatureField(draft.customer.id)] },
    database,
  );
  await sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    { database },
  );

  assert.deepEqual(await statusesOf(draft.envelopeId), ["notified", "pending"]);
  assert.equal(await invitationsTo(draft.envelopeId, draft.approver.id), 1);
  assert.equal(await invitationsTo(draft.envelopeId, draft.customer.id), 0);
});

test("an envelope of approvers only, or with approvers in Part 11 mode or with a signing provider, is not sent", async () => {
  const onlyApprovers = await createDraft();

  await replaceDraftEnvelopeSigners(
    onlyApprovers.userId,
    onlyApprovers.envelopeId,
    {
      signers: [
        {
          email: onlyApprovers.approver.email,
          id: onlyApprovers.approver.id,
          name: "Bea Boss",
          role: "approver",
        },
      ],
    },
    database,
  );
  await assert.rejects(
    sendDraftEnvelope(
      onlyApprovers.userId,
      onlyApprovers.envelopeId,
      { senderEmail: "sam@example.test", senderName: "Sam Sender" },
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /place fields/.test(error.message),
  );

  // The sender is told why on the review page, which is where the rule
  // about someone having to sign is the explanation they see.
  const review = await getReviewEnvelopeDataForUser(
    onlyApprovers.userId,
    onlyApprovers.envelopeId,
    database,
  );

  assert.equal(review?.canSend, false);
  assert.match(review?.disabledReason ?? "", /Add at least one signer/);

  const provider = await createDraft();

  await replaceDraftEnvelopeFields(
    provider.userId,
    provider.envelopeId,
    { fields: [signatureField(provider.customer.id)] },
    database,
  );
  await assert.rejects(
    sendDraftEnvelope(
      provider.userId,
      provider.envelopeId,
      {
        senderEmail: "sam@example.test",
        senderName: "Sam Sender",
        signatureLevel: "advanced",
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /Approvers work with SignuDoc signatures only/.test(error.message),
  );

  const part11 = await createDraft();

  await replaceDraftEnvelopeFields(
    part11.userId,
    part11.envelopeId,
    { fields: [signatureField(part11.customer.id)] },
    database,
  );

  const before = await database.query<{ part11_mode: boolean }>(
    `select part11_mode from app_settings where id`,
  );
  const now = Math.floor(Date.now() / 1000);

  if (before.rowCount === 0) {
    await database.query(
      `insert into app_settings (id, part11_mode, created_at, updated_at) values (true, true, $1, $1)`,
      [now],
    );
  } else {
    await database.query(`update app_settings set part11_mode = true where id`);
  }

  try {
    await assert.rejects(
      sendDraftEnvelope(
        part11.userId,
        part11.envelopeId,
        { senderEmail: "sam@example.test", senderName: "Sam Sender" },
        { database },
      ),
      (error: unknown) =>
        error instanceof EnvelopeMutationError &&
        /Part 11 mode has no approvers/.test(error.message),
    );
  } finally {
    if (before.rowCount === 0) {
      await database.query(`delete from app_settings where id`);
    } else {
      await database.query(
        `update app_settings set part11_mode = $1 where id`,
        [before.rows[0]!.part11_mode],
      );
    }
  }

  for (const draft of [onlyApprovers, provider, part11]) {
    assert.equal((await envelopeOf(draft.envelopeId)).status, "draft");
  }
});
