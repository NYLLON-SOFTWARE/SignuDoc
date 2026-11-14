import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";
import { ZodError } from "zod";

import { afterStatement, openTestDatabase } from "./db/test-database.ts";
import {
  copyEnvelopeToDraft,
  createDraftEnvelope,
  deleteDraftEnvelope,
  EnvelopeMutationError,
  getDraftEnvelopeDocumentForUser,
  getDraftSignerStepDataForUser,
  getEnvelopeDetailDataForUser,
  getPrepareEnvelopeDataForUser,
  listCopyRecipientsForEnvelopeId,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  saveEnvelopeThumbnailForUser,
} from "./envelopes.ts";
import { deleteEnvelopesAndFiles } from "./retention.ts";
import {
  listAuditEventsForEnvelope,
  verifyAuditChain,
} from "./services/audit.ts";
import {
  buildEnvelopeOriginalPdfKey,
  buildEnvelopeThumbnailKey,
} from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";

// Copying a finished envelope into a new draft, against a real Postgres
// and real files. Run with `npm run test:db`.

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
let sourcePdf: Uint8Array;
const createdUsers: string[] = [];

const THUMBNAIL = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x6d, 0x01, 0xe0, 0x03, 0x01,
  0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-envelope-copy-"));
  storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });

  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);
  pdf.addPage([612, 792]);
  sourcePdf = await pdf.save();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createUser(): Promise<string> {
  const userId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );

  return userId;
}

function field(
  signerId: string,
  type: string,
  y: number,
  extra: Record<string, unknown> = {},
) {
  return {
    height: 0.03,
    page: 1,
    required: true,
    signerId,
    type,
    width: 0.2,
    x: 0.1,
    y,
    ...extra,
  };
}

async function createPreparedDraft(userId: string) {
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: { body: sourcePdf, filename: "lease.pdf" },
      title: "Lease for 12 Harbour Road",
    },
    { database, storageService },
  );
  const envelopeId = draft.envelope.id;
  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      copyRecipients: [{ email: "zofia@example.test", name: "Zofia Copy" }],
      signers: [
        {
          accessCode: "secret12",
          email: "riley@example.test",
          name: "Riley Recipient",
          requireEmailCode: true,
        },
        {
          email: "casey@example.test",
          name: "Casey Second",
          requireEmailCode: false,
        },
      ],
    },
    database,
  );
  const [riley, casey] = saved.signers.map((signer) => signer.id);
  const groupId = randomUUID();

  await replaceDraftEnvelopeFields(
    userId,
    envelopeId,
    {
      fields: [
        field(riley!, "signature", 0.1),
        field(casey!, "signature", 0.15, { page: 2 }),
        field(riley!, "text", 0.2, { label: "Unit number", required: false }),
        field(riley!, "dropdown", 0.25, { options: ["Monthly", "Yearly"] }),
        field(casey!, "radio", 0.3, { groupId, label: "Furnished" }),
        field(casey!, "radio", 0.35, { groupId, label: "Unfurnished" }),
      ],
    },
    database,
  );

  return { casey: casey!, envelopeId, groupId, riley: riley! };
}

async function markNotDraft(
  envelopeId: string,
  status: "completed" | "declined" | "sent" | "voided",
  extra: {
    expiresAt?: number | null;
    part11?: boolean;
    reminderIntervalDays?: number | null;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `
      update envelopes
      set
        status = $2,
        sent_at = $3,
        completed_at = $4,
        declined_at = $5,
        voided_at = $6,
        expires_at = $7,
        reminder_interval_days = $8,
        part11 = $9
      where id = $1
    `,
    [
      envelopeId,
      status,
      now - 3600,
      status === "completed" ? now : null,
      status === "declined" ? now : null,
      status === "voided" ? now : null,
      extra.expiresAt === undefined ? now + 7 * 24 * 60 * 60 : extra.expiresAt,
      extra.reminderIntervalDays === undefined ? 3 : extra.reminderIntervalDays,
      extra.part11 ?? true,
    ],
  );
  const signerStatus =
    status === "completed"
      ? "signed"
      : status === "declined"
        ? "declined"
        : "notified";

  await database.query(
    `
      update signers
      set
        status = 'pending',
        signing_token_hash = encode(sha256(id::bytea), 'hex'),
        signing_token_expires_at = $2
      where envelope_id = $1 and role = 'signer'
    `,
    [envelopeId, now + 86_400],
  );
  await database.query(
    `
      update signers
      set
        status = $2,
        signed_at = $3,
        declined_at = $4
      where envelope_id = $1 and role = 'signer' and sign_order = 1
    `,
    [
      envelopeId,
      signerStatus,
      status === "completed" ? now : null,
      status === "declined" ? now : null,
    ],
  );

  if (status === "completed") {
    await database.query(
      `
        update signers
        set status = 'signed', signed_at = $2
        where envelope_id = $1 and role = 'signer' and sign_order > 1
      `,
      [envelopeId, now],
    );
  }
  await database.query(
    `
      update fields
      set
        value = case
          when type in ('signature', 'initials', 'text', 'number', 'dropdown', 'date')
            then 'filled'
          else value
        end,
        checked = case
          when type in ('checkbox', 'radio') then true
          else checked
        end,
        input_method = case
          when type in ('signature', 'initials') then 'typed'
          else input_method
        end,
        submitted_at = $2
      where envelope_id = $1
    `,
    [envelopeId, now],
  );
}

async function dumpEnvelope(envelopeId: string) {
  const envelope = await database.query<{ row: string }>(
    `select row_to_json(e)::text as row from envelopes e where id = $1`,
    [envelopeId],
  );
  const signers = await database.query<{ row: string }>(
    `select row_to_json(s)::text as row from signers s where envelope_id = $1 order by sign_order, id`,
    [envelopeId],
  );
  const fields = await database.query<{ row: string }>(
    `select row_to_json(f)::text as row from fields f where envelope_id = $1 order by page, created_at, id`,
    [envelopeId],
  );
  const pages = await database.query<{ row: string }>(
    `select row_to_json(p)::text as row from envelope_pages p where envelope_id = $1 order by page_number, id`,
    [envelopeId],
  );
  const audit = await database.query<{ row: string }>(
    `select row_to_json(a)::text as row from audit_events a where envelope_id = $1 order by created_at, id`,
    [envelopeId],
  );

  return {
    audit: audit.rows.map((row) => row.row),
    envelope: envelope.rows[0]!.row,
    fields: fields.rows.map((row) => row.row),
    pages: pages.rows.map((row) => row.row),
    signers: signers.rows.map((row) => row.row),
  };
}

async function signerChecks(envelopeId: string) {
  const result = await database.query<{
    access_code_hash: string | null;
    email: string;
    require_email_code: boolean;
    signature_meaning: string | null;
    signing_token_hash: string | null;
    status: string;
  }>(
    `
      select
        email,
        status,
        access_code_hash,
        require_email_code,
        signature_meaning,
        signing_token_hash
      from signers
      where envelope_id = $1 and role = 'signer'
      order by sign_order
    `,
    [envelopeId],
  );

  return result.rows;
}

async function envelopeColumns(envelopeId: string) {
  const result = await database.query<{
    expires_at: number | null;
    part11: boolean;
    reminder_interval_days: number | null;
    source_pdf_hash: string;
    source_pdf_key: string;
    status: string;
    title: string;
  }>(
    `
      select
        status,
        title,
        source_pdf_key,
        source_pdf_hash,
        expires_at,
        reminder_interval_days,
        part11
      from envelopes
      where id = $1
    `,
    [envelopeId],
  );

  return result.rows[0]!;
}

async function fileExists(key: string): Promise<boolean> {
  return (await storageService.headObject(key)).exists;
}

async function countEnvelopes(userId: string): Promise<number> {
  const result = await database.query<{ total: number }>(
    `select count(*)::int as total from envelopes where user_id = $1`,
    [userId],
  );

  return result.rows[0]!.total;
}

async function relatedCounts(envelopeId: string) {
  const result = await database.query<{
    fields: number;
    pages: number;
    recipients: number;
    signers: number;
  }>(
    `
      select
        (select count(*)::int from envelope_pages where envelope_id = $1) as pages,
        (select count(*)::int from signers where envelope_id = $1 and role = 'signer') as signers,
        (select count(*)::int from signers where envelope_id = $1 and role = 'cc') as recipients,
        (select count(*)::int from fields where envelope_id = $1) as fields
    `,
    [envelopeId],
  );

  return result.rows[0]!;
}

async function waitForLockWaiters(count: number) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await database.query<{ waiting: number }>(
      `
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `,
    );

    if ((result.rows[0]?.waiting ?? 0) >= count) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Expected ${count} sessions to be waiting behind a lock.`);
}

function assertMutationError(statusCode: number) {
  return (error: unknown): true => {
    assert.ok(error instanceof EnvelopeMutationError, String(error));
    assert.equal(error.statusCode, statusCode);

    return true;
  };
}

function fieldShape(
  placed: {
    groupId?: string;
    height: number;
    label?: string;
    options?: string[];
    page: number;
    required: boolean;
    signerId: string;
    type: string;
    width: number;
    x: number;
    y: number;
  },
  signerOrderById: Map<string, number>,
) {
  return {
    assignment: signerOrderById.get(placed.signerId),
    groupId: placed.groupId ?? null,
    height: placed.height,
    label: placed.label ?? null,
    options: placed.options ?? null,
    page: placed.page,
    required: placed.required,
    type: placed.type,
    width: placed.width,
    x: placed.x,
    y: placed.y,
  };
}

test("a completed envelope is copied into a new draft with people, fields and a separate document", async () => {
  const userId = await createUser();
  const { envelopeId: originalId, groupId } = await createPreparedDraft(userId);

  await markNotDraft(originalId, "completed");
  await saveEnvelopeThumbnailForUser(userId, originalId, THUMBNAIL, {
    database,
    storageService,
  });

  const originalBefore = await dumpEnvelope(originalId);
  const originalDocument = await getDraftEnvelopeDocumentForUser(
    userId,
    originalId,
    { database, storageService },
  );
  const originalPrepared = await getPrepareEnvelopeDataForUser(
    userId,
    originalId,
    { database },
  );
  const originalCopyRecipients = await listCopyRecipientsForEnvelopeId(
    originalId,
    database,
  );
  const originalKey = (await envelopeColumns(originalId)).source_pdf_key;
  const originalThumbnailKey = buildEnvelopeThumbnailKey({
    envelopeId: originalId,
    sourcePdfKey: originalKey,
    userId,
  });

  assert.equal(await fileExists(originalThumbnailKey), true);

  const copied = await copyEnvelopeToDraft(userId, originalId, {
    actorEmail: "sam@example.test",
    database,
    storageService,
  });

  assert.notEqual(copied.id, originalId);
  assert.deepEqual(await dumpEnvelope(originalId), originalBefore);

  const originalAfter = await envelopeColumns(originalId);
  const draft = await envelopeColumns(copied.id);

  assert.equal(originalAfter.status, "completed");
  assert.equal(draft.status, "draft");
  assert.equal(draft.title, originalAfter.title);
  assert.equal(draft.title, "Lease for 12 Harbour Road");
  assert.notEqual(draft.source_pdf_key, originalAfter.source_pdf_key);
  assert.equal(draft.source_pdf_hash, originalAfter.source_pdf_hash);
  assert.equal(draft.expires_at, null);
  assert.equal(draft.reminder_interval_days, null);
  assert.equal(draft.part11, false);
  assert.equal(originalAfter.expires_at !== null, true);
  assert.equal(originalAfter.reminder_interval_days, 3);
  assert.equal(originalAfter.part11, true);

  const copiedDocument = await getDraftEnvelopeDocumentForUser(
    userId,
    copied.id,
    { database, storageService },
  );

  assert.equal(sha256(copiedDocument.body), sha256(originalDocument.body));
  assert.equal(copiedDocument.body.length, sourcePdf.length);
  assert.equal(
    draft.source_pdf_key,
    buildEnvelopeOriginalPdfKey({ envelopeId: copied.id, userId }),
  );

  const copiedThumbnailKey = buildEnvelopeThumbnailKey({
    envelopeId: copied.id,
    sourcePdfKey: draft.source_pdf_key,
    userId,
  });

  assert.equal(await fileExists(copiedThumbnailKey), false);

  const prepared = await getPrepareEnvelopeDataForUser(userId, copied.id, {
    database,
  });
  const step = await getDraftSignerStepDataForUser(userId, copied.id, database);
  const detail = await getEnvelopeDetailDataForUser(
    userId,
    copied.id,
    database,
  );
  const checks = await signerChecks(copied.id);
  const copyRecipients = await listCopyRecipientsForEnvelopeId(
    copied.id,
    database,
  );

  assert.ok(prepared);
  assert.ok(step);
  assert.ok(detail);
  assert.equal(prepared.status, "draft");
  assert.deepEqual(
    prepared.signers.map((signer) => [signer.order, signer.name, signer.email]),
    [
      [1, "Riley Recipient", "riley@example.test"],
      [2, "Casey Second", "casey@example.test"],
    ],
  );
  assert.equal(
    originalPrepared!.signers.filter((signer) =>
      prepared.signers.some((copiedSigner) => copiedSigner.id === signer.id),
    ).length,
    0,
  );
  assert.deepEqual(
    checks.map((row) => [
      row.email,
      row.status,
      row.access_code_hash,
      row.require_email_code,
      row.signature_meaning,
      row.signing_token_hash,
    ]),
    [
      ["riley@example.test", "pending", null, true, null, null],
      ["casey@example.test", "pending", null, false, null, null],
    ],
  );
  assert.deepEqual(
    step.signers.map((signer) => [
      signer.hasAccessCode,
      signer.requireEmailCode,
    ]),
    [
      [false, true],
      [false, false],
    ],
  );
  assert.deepEqual(
    copyRecipients.map((recipient) => [recipient.name, recipient.email]),
    originalCopyRecipients.map((recipient) => [
      recipient.name,
      recipient.email,
    ]),
  );
  assert.notEqual(copyRecipients[0]?.id, originalCopyRecipients[0]?.id);

  const originalOrder = new Map(
    originalPrepared!.signers.map((signer) => [signer.id, signer.order]),
  );
  const copiedOrder = new Map(
    prepared.signers.map((signer) => [signer.id, signer.order]),
  );

  assert.deepEqual(
    prepared.fields.map((placed) => fieldShape(placed, copiedOrder)),
    originalPrepared!.fields.map((placed) => fieldShape(placed, originalOrder)),
  );
  assert.ok(
    prepared.fields.every(
      (placed) =>
        (placed.value ?? null) === null &&
        (placed.checked ?? null) === null &&
        (placed.imageKey ?? null) === null &&
        (placed.inputMethod ?? null) === null &&
        (placed.submittedAt ?? null) === null,
    ),
  );
  assert.ok(
    originalPrepared!.fields.some(
      (placed) => placed.value === "filled" || placed.checked === true,
    ),
  );

  const radios = prepared.fields.filter((placed) => placed.type === "radio");

  assert.equal(radios[0]!.groupId, groupId);
  assert.equal(radios[1]!.groupId, groupId);
  assert.deepEqual(
    prepared.pages.map((page) => [
      page.pageNumber,
      page.widthPt,
      page.heightPt,
    ]),
    originalPrepared!.pages.map((page) => [
      page.pageNumber,
      page.widthPt,
      page.heightPt,
    ]),
  );
  assert.notDeepEqual(
    prepared.pages.map((page) => page.id),
    originalPrepared!.pages.map((page) => page.id),
  );

  assert.deepEqual(
    detail.timeline.map((event) => event.description),
    ["Copied from an earlier envelope"],
  );
  assert.deepEqual(await verifyAuditChain(copied.id, database), {
    chainedEvents: 1,
    ok: true,
  });
  assert.deepEqual(await verifyAuditChain(originalId, database), {
    chainedEvents: 1,
    ok: true,
  });
  assert.deepEqual(
    (await listAuditEventsForEnvelope(copied.id, database)).map(
      (event) => event.event,
    ),
    ["copied"],
  );
  assert.deepEqual(
    (await listAuditEventsForEnvelope(originalId, database)).map(
      (event) => event.event,
    ),
    ["created"],
  );

  await deleteDraftEnvelope(userId, copied.id, { database, storageService });

  assert.equal(await fileExists(originalKey), true);
  assert.equal(await fileExists(draft.source_pdf_key), false);

  const second = await copyEnvelopeToDraft(userId, originalId, {
    database,
    storageService,
  });
  const secondKey = (await envelopeColumns(second.id)).source_pdf_key;

  await deleteEnvelopesAndFiles([originalId], database, storageService);

  assert.equal(await fileExists(originalKey), false);
  assert.equal(await fileExists(secondKey), true);
  assert.equal(
    sha256(
      (
        await getDraftEnvelopeDocumentForUser(userId, second.id, {
          database,
          storageService,
        })
      ).body,
    ),
    sha256(originalDocument.body),
  );
});

test("a declined or voided envelope can be copied, and so can one still out or past its deadline", async () => {
  const userId = await createUser();
  const now = Math.floor(Date.now() / 1000);
  const cases: Array<{
    extra?: Parameters<typeof markNotDraft>[2];
    status: "declined" | "sent" | "voided";
  }> = [
    { status: "declined" },
    { status: "voided" },
    { status: "sent" },
    { extra: { expiresAt: now - 60 }, status: "sent" },
  ];

  for (const { extra, status } of cases) {
    const { envelopeId } = await createPreparedDraft(userId);

    await markNotDraft(envelopeId, status, extra);

    const copied = await copyEnvelopeToDraft(userId, envelopeId, {
      database,
      storageService,
    });
    const draft = await envelopeColumns(copied.id);
    const prepared = await getPrepareEnvelopeDataForUser(userId, copied.id, {
      database,
    });

    assert.equal(draft.status, "draft", status);
    assert.equal(draft.title, "Lease for 12 Harbour Road", status);
    assert.equal(prepared?.signers.length, 2, status);
    assert.equal(prepared?.fields.length, 6, status);
    assert.ok(
      prepared?.fields.every((placed) => (placed.value ?? null) === null),
      status,
    );
  }
});

test("a draft cannot be copied", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);
  const before = await countEnvelopes(userId);

  await assert.rejects(
    copyEnvelopeToDraft(userId, envelopeId, { database, storageService }),
    assertMutationError(409),
  );
  assert.equal(await countEnvelopes(userId), before);
});

test("someone else's envelope cannot be copied", async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const { envelopeId } = await createPreparedDraft(owner);

  await markNotDraft(envelopeId, "completed");

  await assert.rejects(
    copyEnvelopeToDraft(stranger, envelopeId, { database, storageService }),
    assertMutationError(404),
  );
  assert.equal(await countEnvelopes(stranger), 0);
  assert.equal((await envelopeColumns(envelopeId)).status, "completed");
});

test("a missing document is refused and leaves no draft", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);

  await markNotDraft(envelopeId, "completed");

  const key = (await envelopeColumns(envelopeId)).source_pdf_key;

  await storageService.deleteObject(key);

  const before = await dumpEnvelope(envelopeId);
  const envelopeCount = await countEnvelopes(userId);

  await assert.rejects(
    copyEnvelopeToDraft(userId, envelopeId, { database, storageService }),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError, String(error));
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /no longer available/);

      return true;
    },
  );
  assert.equal(await countEnvelopes(userId), envelopeCount);
  assert.deepEqual(await dumpEnvelope(envelopeId), before);
});

test("what is copied is checked", async () => {
  const userId = await createUser();

  await assert.rejects(
    copyEnvelopeToDraft(userId, "   ", { database, storageService }),
    ZodError,
  );
});

test("a copy that loses the source to a purge does not leave a half-made draft", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);

  await markNotDraft(envelopeId, "completed");

  const holder = await database.connect();

  try {
    await holder.query("begin");
    await holder.query(
      `select id from envelopes where id = $1 for no key update`,
      [envelopeId],
    );

    const copy = copyEnvelopeToDraft(userId, envelopeId, {
      database,
      storageService,
    });

    copy.catch(() => undefined);
    await waitForLockWaiters(1);

    await holder.query(`delete from envelopes where id = $1`, [envelopeId]);
    await holder.query("commit");

    await assert.rejects(copy, assertMutationError(404));
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
  }

  assert.equal(await countEnvelopes(userId), 0);
});

test("a purge waits for the copy, so the new draft still has the source's fields", async () => {
  const userId = await createUser();
  const { envelopeId } = await createPreparedDraft(userId);

  await markNotDraft(envelopeId, "completed");

  const original = await relatedCounts(envelopeId);
  let purge: Promise<number> | undefined;

  const copied = await copyEnvelopeToDraft(userId, envelopeId, {
    database: afterStatement(
      database,
      (text) =>
        text.includes("FOR NO KEY UPDATE") &&
        text.includes("signature_level") &&
        text.includes("FROM envelopes"),
      async () => {
        if (purge) {
          return;
        }

        purge = deleteEnvelopesAndFiles([envelopeId], database, storageService);
        purge.catch(() => undefined);
        await waitForLockWaiters(1);
      },
    ),
    storageService,
  });

  assert.ok(purge, "the copy never took hold of the source");
  await purge;

  assert.equal(await countEnvelopes(userId), 1);
  assert.deepEqual(await relatedCounts(envelopeId), {
    fields: 0,
    pages: 0,
    recipients: 0,
    signers: 0,
  });
  assert.deepEqual(await relatedCounts(copied.id), original);
  assert.equal((await envelopeColumns(copied.id)).status, "draft");
  assert.equal(original.fields > 0, true);
  assert.equal(original.signers > 0, true);
  assert.equal(original.pages > 0, true);
});
