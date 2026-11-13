import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  withTransaction,
} from "./db/connection.ts";
import { deleteEnvelopesAndFiles } from "./retention.ts";
import { emailSchema } from "./schemas/common.ts";

// What an administrator needs to answer a signer who asks for their data
// (GDPR Articles 15 and 20) or for it to be erased (Article 17).
//
// A signed document holds every party's signature, and its seal breaks if
// any part is removed, so erasure works on whole envelopes. Envelopes still
// out for signature are never touched: void them first.

export class SignerDataError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "SignerDataError";
    this.statusCode = statusCode;
  }
}

type SignerEnvelopeRow = {
  declineReason: string | null;
  declinedAt: number | null;
  envelopeCreatedAt: number;
  envelopeId: string;
  envelopeStatus: string;
  envelopeTitle: string;
  /** Sent in Part 11 mode: never erased here. */
  part11: boolean;
  signedAt: number | null;
  signerEmail: string;
  signerId: string;
  signerName: string;
  signerStatus: string;
  /** "signer", or "cc" for someone who only received a copy. */
  role: string;
};

function parseEmail(email: unknown): string {
  const parsed = emailSchema.safeParse(email);

  if (!parsed.success) {
    throw new SignerDataError("Enter the signer's email address.");
  }

  return parsed.data.toLowerCase();
}

async function listSignerEnvelopes(
  email: string,
  database: DbExecutor,
): Promise<SignerEnvelopeRow[]> {
  return queryMany<SignerEnvelopeRow>(
    database,
    `
      SELECT
        s.id AS "signerId",
        s.name AS "signerName",
        s.email AS "signerEmail",
        s.status AS "signerStatus",
        s.role AS "role",
        s.signed_at AS "signedAt",
        s.declined_at AS "declinedAt",
        s.decline_reason AS "declineReason",
        e.id AS "envelopeId",
        e.title AS "envelopeTitle",
        e.status AS "envelopeStatus",
        e.part11,
        e.created_at AS "envelopeCreatedAt"
      FROM signers s
      JOIN envelopes e ON e.id = s.envelope_id
      WHERE lower(s.email) = $1
      ORDER BY e.created_at ASC, e.id ASC
    `,
    [email],
  );
}

export type SignerDataExport = {
  auditEvents: Record<string, unknown>[];
  email: string;
  envelopes: SignerEnvelopeRow[];
  exportedAt: string;
  fields: Record<string, unknown>[];
  note: string;
};

/** Everything stored about one signer email, as JSON. */
export async function exportSignerData(
  rawEmail: unknown,
  database: DbExecutor = getDb(),
): Promise<SignerDataExport> {
  const email = parseEmail(rawEmail);
  const envelopes = await listSignerEnvelopes(email, database);
  const signerIds = envelopes.map((row) => row.signerId);
  const envelopeIds = envelopes.map((row) => row.envelopeId);
  const [fields, auditEvents] = await Promise.all([
    queryMany<Record<string, unknown>>(
      database,
      `
        SELECT
          envelope_id AS "envelopeId",
          type,
          label,
          input_method AS "inputMethod",
          value,
          checked,
          image_key IS NOT NULL AS "hasImage",
          submitted_at AS "submittedAt"
        FROM fields
        WHERE signer_id = ANY($1::text[])
        ORDER BY envelope_id, page, y, x
      `,
      [signerIds],
    ),
    queryMany<Record<string, unknown>>(
      database,
      `
        SELECT
          envelope_id AS "envelopeId",
          event,
          actor_type AS "actorType",
          actor_email AS "actorEmail",
          ip_address AS "ipAddress",
          user_agent AS "userAgent",
          metadata,
          created_at AS "createdAt"
        FROM audit_events
        WHERE envelope_id = ANY($1::text[])
          AND (lower(actor_email) = $2 OR metadata->>'signerId' = ANY($3::text[]))
        ORDER BY created_at, sequence NULLS LAST
      `,
      [envelopeIds, email, signerIds],
    ),
  ]);

  return {
    auditEvents,
    email,
    envelopes,
    exportedAt: new Date().toISOString(),
    fields,
    note: "Signed PDFs and audit certificates are not included here. Download them from each envelope, or ask the sender.",
  };
}

export type SignerErasureResult = {
  deletedEnvelopes: number;
  /** Part 11 records, which an erasure request does not delete. */
  keptPart11: { id: string; title: string }[];
  removedFromDrafts: number;
  skippedInProgress: { id: string; title: string }[];
};

/**
 * Erases one signer email: drops them from drafts and deletes every
 * finished envelope they took part in, with its files and audit trail.
 * The caller must have confirmed that no law requires those records kept.
 */
export async function eraseSignerData(
  rawEmail: unknown,
  confirmation: unknown,
  database: DbPool = getDb(),
): Promise<SignerErasureResult> {
  const email = parseEmail(rawEmail);

  if (
    typeof confirmation !== "string" ||
    confirmation.trim().toLowerCase() !== email
  ) {
    throw new SignerDataError(
      "Type the signer's email address again to confirm.",
    );
  }

  const envelopes = await listSignerEnvelopes(email, database);
  const drafts = envelopes.filter((row) => row.envelopeStatus === "draft");
  const allFinished = envelopes.filter((row) =>
    ["completed", "declined", "voided"].includes(row.envelopeStatus),
  );
  // Part 11 records are kept for as long as their own rules require, which
  // an erasure request does not override. They are reported instead.
  const keptPart11 = allFinished.filter((row) => row.part11);
  const finished = allFinished.filter((row) => !row.part11);
  const inProgress = envelopes.filter((row) => row.envelopeStatus === "sent");

  // Lock the drafts and look again, at their status and at who is on them.
  // The list above was read a moment ago: a draft that was sent since is
  // skipped, not stripped of a signer mid-signing, and a signer's row that
  // was given someone else's address since is left alone. Saving a draft's
  // signers takes the same lock on the envelope first, so no save is half
  // done while the rows are read here.
  const draftEnvelopeIds = [...new Set(drafts.map((row) => row.envelopeId))];
  const erasedFromDrafts =
    draftEnvelopeIds.length === 0
      ? { removed: 0, stillDrafts: new Set<string>() }
      : await withTransaction(async (tx) => {
          const stillDrafts = await tx.query<{ id: string }>(
            `
              SELECT id FROM envelopes
              WHERE id = ANY($1::text[]) AND status = 'draft'
              FOR UPDATE
            `,
            [draftEnvelopeIds],
          );
          const draftIds = stillDrafts.rows.map((row) => row.id);
          const signers = await tx.query<{ id: string }>(
            `
              SELECT id FROM signers
              WHERE envelope_id = ANY($1::text[]) AND lower(email) = $2
              FOR UPDATE
            `,
            [draftIds, email],
          );
          const signerIds = signers.rows.map((row) => row.id);

          await tx.query(
            `DELETE FROM fields WHERE signer_id = ANY($1::text[])`,
            [signerIds],
          );
          await tx.query(`DELETE FROM signers WHERE id = ANY($1::text[])`, [
            signerIds,
          ]);

          return { removed: signerIds.length, stillDrafts: new Set(draftIds) };
        }, database);
  const raced = drafts.filter(
    (row) => !erasedFromDrafts.stillDrafts.has(row.envelopeId),
  );

  const deletedEnvelopes = await deleteEnvelopesAndFiles(
    [...new Set(finished.map((row) => row.envelopeId))],
    database,
  );

  return {
    deletedEnvelopes,
    keptPart11: keptPart11.map((row) => ({
      id: row.envelopeId,
      title: row.envelopeTitle,
    })),
    removedFromDrafts: erasedFromDrafts.removed,
    skippedInProgress: [...inProgress, ...raced].map((row) => ({
      id: row.envelopeId,
      title: row.envelopeTitle,
    })),
  };
}
