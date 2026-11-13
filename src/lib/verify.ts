import { z } from "zod";

import { getDb, queryOne, type DbExecutor } from "./db/connection.ts";

// The Verify page: anyone holding a copy of a finished document or
// certificate can check that it is exactly the file this install produced.
// The browser hashes the file; only the hash is sent. A match says nothing
// the holder could not already read in the file itself.

export const verifyRequestSchema = z.object({
  sha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 value."),
});

export type VerifyResult =
  | { match: false }
  | {
      envelopeId: string;
      fileKind: "signed-document" | "certificate";
      finishedAt: number | null;
      match: true;
      signerCount: number;
      status: "completed" | "declined" | "voided";
      title: string;
    };

type VerifyRow = {
  completedAt: number | null;
  declinedAt: number | null;
  envelopeId: string;
  evidenceSha256: string | null;
  recipientEvidenceSha256: string | null;
  signedPdfSha256: string | null;
  signerCount: number;
  status: "completed" | "declined" | "voided";
  title: string;
  voidedAt: number | null;
};

export async function verifyDocumentHash(
  sha256: string,
  database: DbExecutor = getDb(),
): Promise<VerifyResult> {
  const row = await queryOne<VerifyRow>(
    database,
    `
      SELECT
        e.id AS "envelopeId",
        e.title,
        e.status,
        e.completed_at AS "completedAt",
        e.declined_at AS "declinedAt",
        e.voided_at AS "voidedAt",
        e.signed_pdf_sha256 AS "signedPdfSha256",
        e.evidence_sha256 AS "evidenceSha256",
        e.recipient_evidence_sha256 AS "recipientEvidenceSha256",
        (SELECT count(*)::int FROM signers s WHERE s.envelope_id = e.id AND s.role = 'signer') AS "signerCount"
      FROM envelopes e
      WHERE e.signed_pdf_sha256 = $1
         OR e.evidence_sha256 = $1
         OR e.recipient_evidence_sha256 = $1
      LIMIT 1
    `,
    [sha256],
  );

  if (!row) {
    return { match: false };
  }

  return {
    envelopeId: row.envelopeId,
    fileKind:
      row.signedPdfSha256 === sha256 ? "signed-document" : "certificate",
    finishedAt: row.completedAt ?? row.declinedAt ?? row.voidedAt,
    match: true,
    signerCount: row.signerCount,
    status: row.status,
    title: row.title,
  };
}
