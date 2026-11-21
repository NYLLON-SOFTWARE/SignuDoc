import { createHash, randomUUID } from "node:crypto";

import { ZodError } from "zod";

import {
  type BulkSendResult,
  type BulkSendRowResult,
  MAX_BULK_SEND_ROWS,
  parseBulkSendCsv,
  summarizeBulkSendRows,
  validateBulkSendRows,
} from "./bulk-send-csv.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
} from "./db/connection.ts";
import {
  deleteDraftEnvelope,
  draftRecipientsChangedMessage,
  draftRecipientsMatch,
  EnvelopeMutationError,
  getPrepareEnvelopeDataForUser,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import { describePart11SignerProblem, findSignerAccounts } from "./part11.ts";
import {
  bulkSendRequestSchema,
  type BulkSendRequest,
} from "./schemas/bulk-send.ts";
import { logRouteError } from "./security/logging.ts";
import { DocumentImportError } from "./services/document-import.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { readStoredSettings } from "./settings.ts";
import {
  createDraftFromTemplate,
  describeUnsendableTemplate,
  getTemplateForBulkSend,
  TemplateError,
} from "./templates.ts";
import { type SignatureMeaning } from "./types/domain.ts";

// Send one template to many people: each CSV row becomes its own envelope,
// created from the template and sent the same way a hand-sent draft is.
// Rows are checked first. One row that fails does not take the others with it.
// A confirmed batch is stored by key so a retry does not send the same
// envelopes again.

export const missingBulkSendBatchKeyMessage =
  "This send is missing its batch key.";

export const bulkSendBatchMismatchMessage =
  "This batch key was used with a different list.";

export const bulkSendBatchBusyMessage =
  "This batch is still sending. Wait a moment, then confirm again to see its results.";

export const bulkSendInvitationUnconfirmedMessage =
  "This envelope was marked sent but the invitation was not recorded. Check your documents before sending this row again.";

export const bulkSendSkippedRowMessage =
  "This row was skipped when this batch was first confirmed. Preview the list again and send it as a new batch to include it.";

export class BulkSendError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "BulkSendError";
    this.statusCode = statusCode;
  }
}

/**
 * This request no longer holds the batch: it was too slow and a retry took
 * the claim over. It stops without saving or sending anything more, and the
 * request that holds the claim finishes the batch.
 */
class BulkSendClaimLostError extends BulkSendError {
  constructor() {
    super(bulkSendBatchBusyMessage, 409);
    this.name = "BulkSendClaimLostError";
  }
}

export type BulkSendSender = {
  email: string;
  ipAddress?: string | null;
  name: string;
  userAgent?: string | null;
};

type BulkSendOptions = {
  database?: DbPool;
  sender?: BulkSendSender;
  storageService?: StorageService;
};

type StoredBatch = {
  claimToken: string;
  id: string;
  requestFingerprint: string;
  rows: Map<number, StoredBatchRow>;
};

type StoredBatchRow = {
  envelopeId: string | null;
  reason: string | null;
  status: "failed" | "processing" | "sent" | "skipped";
};

type SendRowContext = {
  batch: StoredBatch;
  copyRecipients: NonNullable<BulkSendRequest["copyRecipients"]>;
  database: DbPool;
  expiresInDays: BulkSendRequest["expiresInDays"];
  progress: { envelopeId: string | null };
  reminderIntervalDays: BulkSendRequest["reminderIntervalDays"];
  requireEmailCode: boolean;
  sender: BulkSendSender;
  signatureMeaning: SignatureMeaning | null;
  storageService: StorageService;
  templateId: string;
  userId: string;
};

const TERMINAL_ROW_STATUSES = new Set<StoredBatchRow["status"]>([
  "failed",
  "sent",
  "skipped",
]);

/**
 * How long a claim on a batch lasts without being refreshed. The request
 * sending a batch refreshes it before each step of a row, so this only has
 * to outlast one step. A request that dies leaves a claim a retry can take
 * after this, and a request that loses its claim stops before it saves or
 * sends.
 */
export const BULK_SEND_CLAIM_STALE_SECONDS = 5 * 60;

function describeSendFailure(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? "Invalid signer details.";
  }

  if (
    error instanceof BulkSendError ||
    error instanceof TemplateError ||
    error instanceof EnvelopeMutationError ||
    error instanceof DocumentImportError
  ) {
    return error.message;
  }

  return "Unable to send this envelope.";
}

function isExpectedSendFailure(error: unknown): boolean {
  return (
    error instanceof ZodError ||
    error instanceof TemplateError ||
    error instanceof EnvelopeMutationError ||
    error instanceof DocumentImportError ||
    error instanceof BulkSendError
  );
}

function withReason(row: BulkSendRowResult, reason: string): BulkSendRowResult {
  return {
    ...row,
    envelopeId: null,
    envelopePath: null,
    reason,
    status: "skipped",
  };
}

async function applyPart11Problems(
  rows: readonly BulkSendRowResult[],
  signatureMeaning: SignatureMeaning | null | undefined,
  database: DbExecutor,
): Promise<BulkSendRowResult[]> {
  const emails = rows.flatMap((row) =>
    row.status === "ok" ? row.signers.map((signer) => signer.email) : [],
  );
  const accounts = await findSignerAccounts(emails, database);

  return rows.map((row) => {
    if (row.status !== "ok") {
      return row;
    }

    for (const signer of row.signers) {
      const problem = describePart11SignerProblem(
        {
          email: signer.email,
          name: signer.name,
          signatureMeaning: signatureMeaning ?? null,
        },
        accounts.get(signer.email.toLowerCase()),
      );

      if (problem) {
        return withReason(row, problem);
      }
    }

    return row;
  });
}

function envelopePath(envelopeId: string): string {
  return `/envelopes/${envelopeId}`;
}

function fingerprintBulkSendRequest(
  templateId: string,
  input: BulkSendRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        copyRecipients: input.copyRecipients ?? [],
        csv: input.csv,
        expiresInDays: input.expiresInDays ?? null,
        reminderIntervalDays: input.reminderIntervalDays ?? null,
        requireEmailCode: input.requireEmailCode === true,
        signatureMeaning: input.signatureMeaning ?? null,
        templateId,
      }),
    )
    .digest("hex");
}

function sentRow(
  row: BulkSendRowResult,
  envelopeId: string,
): BulkSendRowResult {
  return {
    ...row,
    envelopeId,
    envelopePath: envelopePath(envelopeId),
    reason: null,
    status: "sent",
  };
}

function failedRow(
  row: BulkSendRowResult,
  envelopeId: string | null,
  error: unknown,
): BulkSendRowResult {
  return {
    ...row,
    envelopeId,
    envelopePath: envelopeId ? envelopePath(envelopeId) : null,
    reason: describeSendFailure(error),
    status: "failed",
  };
}

async function loadBatchRows(
  batchId: string,
  database: DbExecutor,
): Promise<Map<number, StoredBatchRow>> {
  const rows = await queryMany<{
    envelopeId: string | null;
    reason: string | null;
    rowNumber: number;
    status: StoredBatchRow["status"];
  }>(
    database,
    `
      SELECT
        row_number AS "rowNumber",
        status,
        envelope_id AS "envelopeId",
        reason
      FROM bulk_send_batch_rows
      WHERE batch_id = $1
    `,
    [batchId],
  );

  return new Map(
    rows.map((row) => [
      row.rowNumber,
      {
        envelopeId: row.envelopeId,
        reason: row.reason,
        status: row.status,
      },
    ]),
  );
}

/**
 * Creates the batch or takes it over, and claims it for this request. The
 * claim is a saved token, not a session lock, so it holds through pooled
 * connections and no connection waits on it. A batch another request is
 * still sending is refused at once; the sender can confirm again later and
 * get the stored results.
 */
async function claimBatch(
  userId: string,
  templateId: string,
  batchKey: string,
  requestFingerprint: string,
  database: DbExecutor,
): Promise<StoredBatch> {
  const claimToken = randomUUID();
  const claimed = await queryOne<{ id: string }>(
    database,
    `
      INSERT INTO bulk_send_batches (
        id,
        user_id,
        template_id,
        batch_key,
        request_fingerprint,
        claim_token,
        claimed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, extract(epoch from now())::bigint)
      ON CONFLICT (user_id, batch_key) DO UPDATE SET
        claim_token = EXCLUDED.claim_token,
        claimed_at = EXCLUDED.claimed_at
      WHERE bulk_send_batches.request_fingerprint = EXCLUDED.request_fingerprint
        AND (
          bulk_send_batches.claim_token IS NULL
          OR bulk_send_batches.claimed_at < EXCLUDED.claimed_at - $7
        )
      RETURNING id
    `,
    [
      randomUUID(),
      userId,
      templateId,
      batchKey,
      requestFingerprint,
      claimToken,
      BULK_SEND_CLAIM_STALE_SECONDS,
    ],
  );

  if (!claimed) {
    const existing = await queryOne<{ requestFingerprint: string }>(
      database,
      `
        SELECT request_fingerprint AS "requestFingerprint"
        FROM bulk_send_batches
        WHERE user_id = $1 AND batch_key = $2
      `,
      [userId, batchKey],
    );

    if (existing && existing.requestFingerprint !== requestFingerprint) {
      throw new BulkSendError(bulkSendBatchMismatchMessage, 409);
    }

    throw new BulkSendError(bulkSendBatchBusyMessage, 409);
  }

  return {
    claimToken,
    id: claimed.id,
    requestFingerprint,
    rows: await loadBatchRows(claimed.id, database),
  };
}

/** Keeps this request's claim fresh, or stops if another request took it. */
async function refreshBatchClaim(
  batch: StoredBatch,
  database: DbExecutor,
): Promise<void> {
  const refreshed = await database.query(
    `
      UPDATE bulk_send_batches
      SET claimed_at = extract(epoch from now())::bigint
      WHERE id = $1 AND claim_token = $2
    `,
    [batch.id, batch.claimToken],
  );

  if (refreshed.rowCount === 0) {
    throw new BulkSendClaimLostError();
  }
}

async function releaseBatchClaim(
  batch: StoredBatch,
  database: DbExecutor,
): Promise<void> {
  await database.query(
    `
      UPDATE bulk_send_batches
      SET claim_token = NULL, claimed_at = NULL
      WHERE id = $1 AND claim_token = $2
    `,
    [batch.id, batch.claimToken],
  );
}

/**
 * Saves a row only while this request still holds the batch, and refreshes
 * the claim in the same statement. The claim update locks the batch, so a
 * retry taking the claim over either waits for this save and then sees the
 * row's envelope, or wins first and this save writes nothing.
 */
async function saveBatchRow(
  batch: StoredBatch,
  row: BulkSendRowResult,
  status: StoredBatchRow["status"],
  database: DbExecutor,
): Promise<void> {
  const saved = await database.query(
    `
      WITH claim AS (
        UPDATE bulk_send_batches
        SET claimed_at = extract(epoch from now())::bigint
        WHERE id = $1 AND claim_token = $6
        RETURNING id
      )
      INSERT INTO bulk_send_batch_rows (
        batch_id,
        row_number,
        status,
        envelope_id,
        reason
      )
      SELECT claim.id, $2, $3, $4, $5
      FROM claim
      ON CONFLICT (batch_id, row_number)
      DO UPDATE SET
        status = EXCLUDED.status,
        envelope_id = EXCLUDED.envelope_id,
        reason = EXCLUDED.reason
    `,
    [
      batch.id,
      row.rowNumber,
      status,
      row.envelopeId,
      row.reason,
      batch.claimToken,
    ],
  );

  if (saved.rowCount === 0) {
    throw new BulkSendClaimLostError();
  }
}

/**
 * Saves every row skipped by Part 11 checks that has not been recorded yet,
 * guarded by the batch claim like saveBatchRow. Neither envelope_id nor
 * reason is stored, so no personal details are kept on the batch.
 */
async function saveSkippedBatchRows(
  batch: StoredBatch,
  rowNumbers: readonly number[],
  database: DbExecutor,
): Promise<void> {
  if (rowNumbers.length === 0) {
    return;
  }

  const saved = await database.query(
    `
      WITH claim AS (
        UPDATE bulk_send_batches
        SET claimed_at = extract(epoch from now())::bigint
        WHERE id = $1 AND claim_token = $3
        RETURNING id
      ),
      inserted AS (
        INSERT INTO bulk_send_batch_rows (
          batch_id,
          row_number,
          status,
          envelope_id,
          reason
        )
        SELECT claim.id, skipped.row_number, 'skipped', NULL, NULL
        FROM claim
        CROSS JOIN unnest($2::int[]) AS skipped(row_number)
        ON CONFLICT (batch_id, row_number) DO NOTHING
      )
      SELECT id FROM claim
    `,
    [batch.id, rowNumbers, batch.claimToken],
  );

  if (saved.rowCount === 0) {
    throw new BulkSendClaimLostError();
  }

  for (const rowNumber of rowNumbers) {
    if (!batch.rows.has(rowNumber)) {
      batch.rows.set(rowNumber, {
        envelopeId: null,
        reason: null,
        status: "skipped",
      });
    }
  }
}

async function invitationWasRecorded(
  envelopeId: string,
  database: DbExecutor,
): Promise<boolean> {
  const row = await queryOne<{ ok: number }>(
    database,
    `
      SELECT 1 AS ok
      FROM audit_events
      WHERE envelope_id = $1
        AND event = 'email_sent'
        AND metadata->>'template' = 'signing_invitation'
      LIMIT 1
    `,
    [envelopeId],
  );

  return row !== null;
}

function restoreStoredRow(
  row: BulkSendRowResult,
  stored: StoredBatchRow,
): BulkSendRowResult {
  if (stored.status === "sent" && stored.envelopeId) {
    return sentRow(row, stored.envelopeId);
  }

  if (stored.status === "skipped") {
    return withReason(
      row,
      row.status === "skipped" && row.reason
        ? row.reason
        : bulkSendSkippedRowMessage,
    );
  }

  return {
    ...row,
    envelopeId: stored.envelopeId,
    envelopePath: stored.envelopeId ? envelopePath(stored.envelopeId) : null,
    reason: stored.reason ?? "Unable to send this envelope.",
    status: "failed",
  };
}

async function sendOneRow(
  row: BulkSendRowResult,
  stored: StoredBatchRow | undefined,
  context: SendRowContext,
): Promise<BulkSendRowResult> {
  const {
    batch,
    copyRecipients,
    database,
    expiresInDays,
    progress,
    reminderIntervalDays,
    requireEmailCode,
    sender,
    signatureMeaning,
    storageService,
    templateId,
    userId,
  } = context;
  const needsSignerUpdate =
    copyRecipients.length > 0 || requireEmailCode || signatureMeaning !== null;
  let envelopeId = stored?.envelopeId ?? null;

  progress.envelopeId = envelopeId;

  if (envelopeId && (await invitationWasRecorded(envelopeId, database))) {
    return sentRow(row, envelopeId);
  }

  if (envelopeId) {
    const prepared = await getPrepareEnvelopeDataForUser(userId, envelopeId, {
      database,
    });

    if (!prepared) {
      envelopeId = null;
      progress.envelopeId = null;
    } else if (prepared.status !== "draft") {
      throw new BulkSendError(bulkSendInvitationUnconfirmedMessage, 409);
    } else if (
      // The sender can edit a saved draft before retrying. Only the people
      // on the confirmed row are sent to, so a changed draft is left alone.
      !draftRecipientsMatch(
        {
          copyRecipients: [],
          signers: [...prepared.signers].sort(
            (left, right) => left.order - right.order,
          ),
        },
        { copyRecipients: [], signers: row.signers },
      )
    ) {
      throw new EnvelopeMutationError(draftRecipientsChangedMessage, 409);
    }
  }

  if (!envelopeId) {
    const draft = await createDraftFromTemplate(
      userId,
      templateId,
      {
        signers: row.signers.map((signer) => ({
          email: signer.email,
          name: signer.name,
        })),
        title: row.title,
      },
      { database, storageService },
    );

    progress.envelopeId = draft.envelopeId;

    try {
      await saveBatchRow(
        batch,
        { ...row, envelopeId: draft.envelopeId, reason: null },
        "processing",
        database,
      );
    } catch (error) {
      // Another request took the batch while this draft was being made. It
      // makes and sends its own envelope for this row, so this draft is
      // never sent and is removed.
      if (error instanceof BulkSendClaimLostError) {
        await deleteDraftEnvelope(userId, draft.envelopeId, {
          database,
          storageService,
        }).catch(() => undefined);
        progress.envelopeId = null;
      }

      throw error;
    }

    envelopeId = draft.envelopeId;
    progress.envelopeId = envelopeId;
  } else {
    await saveBatchRow(
      batch,
      { ...row, envelopeId, reason: null },
      "processing",
      database,
    );
  }

  if (needsSignerUpdate) {
    await refreshBatchClaim(batch, database);

    const prepared = await getPrepareEnvelopeDataForUser(userId, envelopeId, {
      database,
    });

    if (!prepared) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    if (prepared.status === "draft") {
      await replaceDraftEnvelopeSigners(
        userId,
        envelopeId,
        {
          copyRecipients,
          signers: [...prepared.signers]
            .sort((left, right) => left.order - right.order)
            .map((signer) => ({
              email: signer.email,
              id: signer.id,
              name: signer.name,
              requireEmailCode,
              // An approver in the template stays one.
              role: signer.role,
              signatureMeaning,
              // Signers who share a step keep signing at the same time.
              signingStep: signer.step,
            })),
        },
        database,
      );
    }
  }

  await refreshBatchClaim(batch, database);

  try {
    await sendDraftEnvelope(
      userId,
      envelopeId,
      {
        expiresInDays,
        ipAddress: sender.ipAddress,
        reminderIntervalDays,
        senderEmail: sender.email,
        senderName: sender.name,
        signatureLevel: "simple",
        userAgent: sender.userAgent,
      },
      {
        database,
        expectedRecipients: { copyRecipients, signers: row.signers },
      },
    );
  } catch (error) {
    if (
      error instanceof EnvelopeMutationError &&
      (error.message === "Only draft envelopes can be sent." ||
        error.message === "This envelope has already been sent.") &&
      (await invitationWasRecorded(envelopeId, database))
    ) {
      return sentRow(row, envelopeId);
    }

    throw error;
  }

  return sentRow(row, envelopeId);
}

/**
 * Reads a CSV of people for a template the user owns. With confirm, each
 * valid row is turned into an envelope and sent. Invalid rows are skipped
 * and a failure on one row does not roll back the others. Confirming again
 * with the same batch key returns the stored results.
 */
export async function bulkSendFromTemplate(
  userId: string,
  templateId: string,
  input: unknown,
  {
    database = getDb(),
    sender,
    storageService = createStorageService(),
  }: BulkSendOptions = {},
): Promise<BulkSendResult> {
  const parsedInput = bulkSendRequestSchema.parse(input);
  const template = await getTemplateForBulkSend(userId, templateId, database);

  if (!template) {
    throw new TemplateError("Template not found.", 404);
  }

  const unsendable = describeUnsendableTemplate(
    template.roles,
    template.fields,
  );

  if (unsendable) {
    throw new BulkSendError(unsendable, 400);
  }

  if (parsedInput.confirm && parsedInput.permittedUseConfirmed !== true) {
    throw new BulkSendError(
      "Confirm that these envelopes are ordinary business agreements before sending.",
      400,
    );
  }

  if (parsedInput.confirm && !parsedInput.batchKey) {
    throw new BulkSendError(missingBulkSendBatchKeyMessage, 400);
  }

  if (parsedInput.confirm && !sender) {
    throw new BulkSendError("Unable to send this envelope.", 500);
  }

  const parsedCsv = parseBulkSendCsv(
    parsedInput.csv,
    template.roles,
    template.name,
  );

  if (parsedCsv.error) {
    throw new BulkSendError(parsedCsv.error, 400);
  }

  const copyRecipientEmails = (parsedInput.copyRecipients ?? []).map(
    (recipient) => recipient.email,
  );
  const validatedRows = validateBulkSendRows(
    parsedCsv.rows,
    copyRecipientEmails,
  );
  const part11 = (await readStoredSettings(database))?.part11Mode ?? false;
  const rows = part11
    ? await applyPart11Problems(
        validatedRows,
        parsedInput.signatureMeaning,
        database,
      )
    : validatedRows;

  const resultFor = (nextRows: BulkSendRowResult[]): BulkSendResult => ({
    error: null,
    maxRows: MAX_BULK_SEND_ROWS,
    rows: nextRows,
    summary: summarizeBulkSendRows(nextRows),
    templateId: template.id,
    templateName: template.name,
  });

  if (!parsedInput.confirm) {
    return resultFor(rows);
  }

  const batchKey = parsedInput.batchKey!;
  const copyRecipients = parsedInput.copyRecipients ?? [];
  const requireEmailCode = parsedInput.requireEmailCode === true;
  const signatureMeaning = parsedInput.signatureMeaning ?? null;
  const fingerprint = fingerprintBulkSendRequest(template.id, parsedInput);

  const batch = await claimBatch(
    userId,
    template.id,
    batchKey,
    fingerprint,
    database,
  );

  try {
    const part11SkippedRowNumbers = part11
      ? rows
          .filter(
            (row, index) =>
              validatedRows[index]?.status === "ok" &&
              row.status === "skipped" &&
              !batch.rows.has(row.rowNumber),
          )
          .map((row) => row.rowNumber)
      : [];

    await saveSkippedBatchRows(batch, part11SkippedRowNumbers, database);

    const sent: BulkSendRowResult[] = [];

    for (const row of rows) {
      const stored = batch.rows.get(row.rowNumber);

      if (stored && TERMINAL_ROW_STATUSES.has(stored.status)) {
        sent.push(restoreStoredRow(row, stored));
        continue;
      }

      // Rows skipped by Part 11 checks are saved above without their reason
      // and restored by restoreStoredRow so a retry never sends them if an
      // account changes in between. Rows that reach here were skipped by CSV
      // validation (past the cap, bad email, duplicates), which the
      // fingerprinted CSV works out the same way on every retry, so they are
      // not saved: a long list past the cap does not cost a write per row,
      // and reasons that can name the person stay out of the batch table.
      if (row.status !== "ok") {
        sent.push(row);
        continue;
      }

      await refreshBatchClaim(batch, database);

      const progress = { envelopeId: stored?.envelopeId ?? null };

      try {
        const result = await sendOneRow(row, stored, {
          batch,
          copyRecipients,
          database,
          expiresInDays: parsedInput.expiresInDays,
          progress,
          reminderIntervalDays: parsedInput.reminderIntervalDays,
          requireEmailCode,
          sender: sender!,
          signatureMeaning,
          storageService,
          templateId,
          userId,
        });

        await saveBatchRow(batch, result, "sent", database);
        sent.push(result);
      } catch (error) {
        if (error instanceof BulkSendClaimLostError) {
          throw error;
        }

        if (!isExpectedSendFailure(error)) {
          logRouteError(error, {
            category: "template_bulk_send_row_failure",
            message:
              "Unexpected failure while sending one row of a template batch.",
            metadata: {
              envelopeId: progress.envelopeId,
              rowNumber: row.rowNumber,
              templateId: template.id,
            },
            userId,
          });
        }

        const failed = failedRow(row, progress.envelopeId, error);

        await saveBatchRow(batch, failed, "failed", database);
        sent.push(failed);
      }
    }

    return resultFor(sent);
  } finally {
    await releaseBatchClaim(batch, database);
  }
}
