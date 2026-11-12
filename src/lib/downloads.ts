import {
  type DbExecutor,
  getDb,
  queryMany,
  queryOne,
} from "./db/connection.ts";
import {
  downloadFileTypeSchema,
  envelopeRecordSchema,
  type EnvelopeRecord,
} from "./schemas/envelope.ts";
import { fieldRecordSchema, type FieldRecord } from "./schemas/field.ts";
import { signerRecordSchema, type SignerRecord } from "./schemas/signer.ts";
import { listAuditEventsForEnvelope } from "./services/audit.ts";
import {
  type IssuedDownloadLink,
  issueRecipientDownloadLink,
} from "./services/downloads.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import {
  renderEnvelopeCertificatePdf,
  renderFinalizedEnvelopePdf,
} from "./services/pdf-finalize.ts";
import {
  createStorageService,
  StorageObjectNotFoundError,
  type StorageService,
} from "./services/storage.ts";
import { getRecipientCertificateKey } from "./services/storage-keys.ts";
import { type DownloadFileType } from "./types/domain.ts";

type EnvelopeRow = {
  completedAt: number | null;
  createdAt: number;
  declinedAt: number | null;
  evidenceKey: string | null;
  id: string;
  pageCount: number;
  sentAt: number | null;
  signedPdfKey: string | null;
  sourcePdfFilename: string;
  sourcePdfHash: string;
  sourcePdfKey: string;
  sourcePdfSizeBytes: number;
  status: EnvelopeRecord["status"];
  title: string;
  updatedAt: number;
  userId: string;
  voidedAt: number | null;
};

type RecipientDownloadTokenRow = {
  createdAt: number;
  envelopeId: string;
  expiresAt: number;
  fileType: DownloadFileType;
  signerId: string;
  tokenHash: string;
};

type SignerRow = {
  createdAt: number;
  declineReason: string | null;
  declinedAt: number | null;
  email: string;
  envelopeId: string;
  id: string;
  lastNotifiedAt: number | null;
  lastNudgedAt: number | null;
  name: string;
  signedAt: number | null;
  signOrder: number;
  signingTokenExpiresAt: number | null;
  signingTokenHash: string | null;
  status: SignerRecord["status"];
  turnStartedAt: number | null;
  updatedAt: number;
};

type FieldRow = {
  checked: boolean | null;
  createdAt: number;
  envelopeId: string;
  height: number;
  id: string;
  imageKey: string | null;
  inputMethod: FieldRecord["inputMethod"] | null;
  label: string | null;
  page: number;
  required: boolean;
  signerId: string;
  submittedAt: number | null;
  type: FieldRecord["type"];
  updatedAt: number;
  value: string | null;
  width: number;
  x: number;
  y: number;
};

export type ResolvedDownload = {
  contentType: string;
  envelopeId: string;
  fileName: string;
  fileType: DownloadFileType;
  key: string;
};

export type SenderEnvelopeDownload = ResolvedDownload & {
  body: Uint8Array;
  contentLength: number;
};

export type EnvelopeDownloadResult = ResolvedDownload | SenderEnvelopeDownload;

export class DownloadAccessError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "DownloadAccessError";
    this.statusCode = statusCode;
  }
}

function mapEnvelopeRow(row: EnvelopeRow): EnvelopeRecord {
  return envelopeRecordSchema.parse(row);
}

function mapSignerRow(row: SignerRow): SignerRecord {
  return signerRecordSchema.parse({
    createdAt: row.createdAt,
    declineReason: row.declineReason ?? undefined,
    declinedAt: row.declinedAt,
    email: row.email,
    envelopeId: row.envelopeId,
    id: row.id,
    lastNotifiedAt: row.lastNotifiedAt,
    lastNudgedAt: row.lastNudgedAt,
    name: row.name,
    signOrder: row.signOrder,
    signedAt: row.signedAt,
    signingTokenExpiresAt: row.signingTokenExpiresAt,
    signingTokenHash: row.signingTokenHash,
    status: row.status,
    turnStartedAt: row.turnStartedAt,
    updatedAt: row.updatedAt,
  });
}

function mapFieldRow(row: FieldRow): FieldRecord {
  return fieldRecordSchema.parse({
    checked: row.checked,
    createdAt: row.createdAt,
    envelopeId: row.envelopeId,
    height: row.height,
    id: row.id,
    imageKey: row.imageKey,
    inputMethod: row.inputMethod,
    label: row.label ?? undefined,
    page: row.page,
    required: row.required,
    signerId: row.signerId,
    submittedAt: row.submittedAt,
    type: row.type,
    updatedAt: row.updatedAt,
    value: row.value ?? undefined,
    width: row.width,
    x: row.x,
    y: row.y,
  });
}

async function getEnvelopeById(
  envelopeId: string,
  database: DbExecutor,
): Promise<EnvelopeRecord | null> {
  const row = await queryOne<EnvelopeRow>(
    database,
    `
      SELECT
        id,
        user_id AS "userId",
        title,
        status,
        source_pdf_key AS "sourcePdfKey",
        source_pdf_filename AS "sourcePdfFilename",
        source_pdf_size_bytes AS "sourcePdfSizeBytes",
        page_count AS "pageCount",
        signed_pdf_key AS "signedPdfKey",
        evidence_key AS "evidenceKey",
        source_pdf_hash AS "sourcePdfHash",
        sent_at AS "sentAt",
        completed_at AS "completedAt",
        declined_at AS "declinedAt",
        voided_at AS "voidedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM envelopes
      WHERE id = $1
    `,
    [envelopeId],
  );

  return row ? mapEnvelopeRow(row) : null;
}

async function getEnvelopeByIdForUser(
  userId: string,
  envelopeId: string,
  database: DbExecutor,
): Promise<EnvelopeRecord | null> {
  const row = await queryOne<EnvelopeRow>(
    database,
    `
      SELECT
        id,
        user_id AS "userId",
        title,
        status,
        source_pdf_key AS "sourcePdfKey",
        source_pdf_filename AS "sourcePdfFilename",
        source_pdf_size_bytes AS "sourcePdfSizeBytes",
        page_count AS "pageCount",
        signed_pdf_key AS "signedPdfKey",
        evidence_key AS "evidenceKey",
        source_pdf_hash AS "sourcePdfHash",
        sent_at AS "sentAt",
        completed_at AS "completedAt",
        declined_at AS "declinedAt",
        voided_at AS "voidedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM envelopes
      WHERE id = $1
        AND user_id = $2
    `,
    [envelopeId, userId],
  );

  return row ? mapEnvelopeRow(row) : null;
}

async function getRecipientDownloadTokenByHash(
  tokenHash: string,
  database: DbExecutor,
): Promise<RecipientDownloadTokenRow | null> {
  return queryOne<RecipientDownloadTokenRow>(
    database,
    `
      SELECT
        token_hash AS "tokenHash",
        envelope_id AS "envelopeId",
        signer_id AS "signerId",
        file_type AS "fileType",
        expires_at AS "expiresAt",
        created_at AS "createdAt"
      FROM recipient_download_tokens
      WHERE token_hash = $1
    `,
    [tokenHash],
  );
}

async function getSignerForEnvelope(
  signerId: string,
  envelopeId: string,
  database: DbExecutor,
): Promise<SignerRecord | null> {
  const row = await queryOne<SignerRow>(
    database,
    `
      SELECT
        id,
        envelope_id AS "envelopeId",
        name,
        email,
        sign_order AS "signOrder",
        status,
        signing_token_hash AS "signingTokenHash",
        signing_token_expires_at AS "signingTokenExpiresAt",
        turn_started_at AS "turnStartedAt",
        last_notified_at AS "lastNotifiedAt",
        last_nudged_at AS "lastNudgedAt",
        signed_at AS "signedAt",
        declined_at AS "declinedAt",
        decline_reason AS "declineReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM signers
      WHERE id = $1
        AND envelope_id = $2
    `,
    [signerId, envelopeId],
  );

  return row ? mapSignerRow(row) : null;
}

async function listSignersForEnvelope(
  envelopeId: string,
  database: DbExecutor,
): Promise<SignerRecord[]> {
  const rows = await queryMany<SignerRow>(
    database,
    `
      SELECT
        id,
        envelope_id AS "envelopeId",
        name,
        email,
        sign_order AS "signOrder",
        status,
        signing_token_hash AS "signingTokenHash",
        signing_token_expires_at AS "signingTokenExpiresAt",
        turn_started_at AS "turnStartedAt",
        last_notified_at AS "lastNotifiedAt",
        last_nudged_at AS "lastNudgedAt",
        signed_at AS "signedAt",
        declined_at AS "declinedAt",
        decline_reason AS "declineReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM signers
      WHERE envelope_id = $1
      ORDER BY sign_order ASC, id ASC
    `,
    [envelopeId],
  );

  return rows.map(mapSignerRow);
}

async function storeRecipientDownloadToken(
  {
    envelopeId,
    expiresAt,
    fileType,
    issuedAt,
    signerId,
    tokenHash,
  }: {
    envelopeId: string;
    expiresAt: number;
    fileType: DownloadFileType;
    issuedAt: number;
    signerId: string;
    tokenHash: string;
  },
  database: DbExecutor,
) {
  await database.query(
    `
      INSERT INTO recipient_download_tokens (
        token_hash,
        envelope_id,
        signer_id,
        file_type,
        expires_at,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (envelope_id, signer_id, file_type)
      DO UPDATE SET
        token_hash = EXCLUDED.token_hash,
        expires_at = EXCLUDED.expires_at,
        created_at = EXCLUDED.created_at
    `,
    [tokenHash, envelopeId, signerId, fileType, expiresAt, issuedAt],
  );
}

export async function createRecipientDownloadLink(
  {
    envelopeId,
    fileType,
    issuedAt,
    signerId,
  }: {
    envelopeId: string;
    fileType: DownloadFileType;
    issuedAt?: number;
    signerId: string;
  },
  {
    database = getDb(),
  }: {
    database?: DbExecutor;
  } = {},
): Promise<IssuedDownloadLink> {
  const issuedLink = await issueRecipientDownloadLink({
    fileType,
    issuedAt,
  });

  await storeRecipientDownloadToken(
    {
      envelopeId,
      expiresAt: issuedLink.exp,
      fileType,
      issuedAt: issuedLink.iat,
      signerId,
      tokenHash: issuedLink.tokenHash,
    },
    database,
  );

  return issuedLink;
}

async function listFieldsForEnvelope(
  envelopeId: string,
  database: DbExecutor,
): Promise<FieldRecord[]> {
  const rows = await queryMany<FieldRow>(
    database,
    `
      SELECT
        id,
        envelope_id AS "envelopeId",
        signer_id AS "signerId",
        type,
        page,
        x,
        y,
        width,
        height,
        required,
        label,
        input_method AS "inputMethod",
        value,
        image_key AS "imageKey",
        checked,
        submitted_at AS "submittedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fields
      WHERE envelope_id = $1
      ORDER BY page ASC, created_at ASC, id ASC
    `,
    [envelopeId],
  );

  return rows.map(mapFieldRow);
}

function sanitizeFileNameSegment(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .slice(0, 120);
}

function buildDownloadFileName(
  envelope: EnvelopeRecord,
  fileType: DownloadFileType,
): string {
  const safeTitle =
    sanitizeFileNameSegment(envelope.title) || `envelope-${envelope.id}`;

  return fileType === "signed"
    ? `${safeTitle} - signed.pdf`
    : `${safeTitle} - certificate.pdf`;
}

function getStoredCertificateKey(
  envelope: EnvelopeRecord,
  redactForRecipients: boolean,
): string | null {
  if (
    !envelope.evidenceKey ||
    !envelope.evidenceKey.trim().replaceAll("\\", "/").endsWith("/internal.pdf")
  ) {
    return null;
  }

  return redactForRecipients
    ? getRecipientCertificateKey(envelope.evidenceKey)
    : envelope.evidenceKey;
}

async function buildSignedPdfDownload(
  envelope: EnvelopeRecord,
  database: DbExecutor,
  storageService: StorageService,
): Promise<EnvelopeDownloadResult> {
  if (envelope.status !== "completed") {
    throw new DownloadAccessError(
      "Signed PDF downloads are available only for completed envelopes.",
      409,
    );
  }

  if (typeof envelope.completedAt !== "number") {
    throw new DownloadAccessError("Signed PDF is unavailable.", 404);
  }

  if (envelope.signedPdfKey) {
    const signedPdfObject = await storageService.headObject(
      envelope.signedPdfKey,
    );

    if (signedPdfObject.exists) {
      return {
        contentType: signedPdfObject.contentType ?? "application/pdf",
        envelopeId: envelope.id,
        fileName: buildDownloadFileName(envelope, "signed"),
        fileType: "signed",
        key: signedPdfObject.key,
      };
    }
  }

  const [auditEvents, fields, signers] = await Promise.all([
    listAuditEventsForEnvelope(envelope.id, database),
    listFieldsForEnvelope(envelope.id, database),
    listSignersForEnvelope(envelope.id, database),
  ]);
  let body: Uint8Array;

  try {
    body = await renderFinalizedEnvelopePdf(
      {
        auditEvents,
        completedAt: envelope.completedAt,
        envelope,
        fields,
        signers,
        sourcePdfKey: envelope.sourcePdfKey,
      },
      {
        storageService,
      },
    );
  } catch (error) {
    // The signed PDF is gone and so is the source it would be rebuilt from,
    // for example after the retention period removed both.
    // The same words as when any other stored file turns out to be gone.
    if (error instanceof StorageObjectNotFoundError) {
      throw new DownloadAccessError("This file is no longer available.", 404);
    }

    throw error;
  }

  if (envelope.signedPdfKey) {
    await storageService.putObject({
      body,
      contentType: "application/pdf",
      key: envelope.signedPdfKey,
    });

    return {
      contentType: "application/pdf",
      envelopeId: envelope.id,
      fileName: buildDownloadFileName(envelope, "signed"),
      fileType: "signed",
      key: envelope.signedPdfKey,
    };
  }

  return {
    body,
    contentLength: body.length,
    contentType: "application/pdf",
    envelopeId: envelope.id,
    fileName: buildDownloadFileName(envelope, "signed"),
    fileType: "signed",
    key: envelope.signedPdfKey ?? envelope.sourcePdfKey,
  };
}

async function buildCertificateDownload(
  envelope: EnvelopeRecord,
  database: DbExecutor,
  storageService: StorageService,
  {
    redactForRecipients = false,
  }: {
    redactForRecipients?: boolean;
  } = {},
): Promise<EnvelopeDownloadResult> {
  if (
    envelope.status !== "completed" &&
    envelope.status !== "declined" &&
    envelope.status !== "voided"
  ) {
    throw new DownloadAccessError(
      "Certificate downloads are available only after completion, decline, or void.",
      409,
    );
  }

  const storedCertificateKey = getStoredCertificateKey(
    envelope,
    redactForRecipients,
  );

  if (storedCertificateKey) {
    const certificateObject =
      await storageService.headObject(storedCertificateKey);

    if (certificateObject.exists) {
      return {
        contentType: certificateObject.contentType ?? "application/pdf",
        envelopeId: envelope.id,
        fileName: buildDownloadFileName(envelope, "evidence"),
        fileType: "evidence",
        key: certificateObject.key,
      };
    }
  }

  const [auditEvents, signers] = await Promise.all([
    listAuditEventsForEnvelope(envelope.id, database),
    listSignersForEnvelope(envelope.id, database),
  ]);
  const body = await renderEnvelopeCertificatePdf({
    auditEvents,
    envelope,
    redactForRecipients,
    signers,
  });

  if (storedCertificateKey) {
    await storageService.putObject({
      body,
      contentType: "application/pdf",
      key: storedCertificateKey,
    });

    return {
      contentType: "application/pdf",
      envelopeId: envelope.id,
      fileName: buildDownloadFileName(envelope, "evidence"),
      fileType: "evidence",
      key: storedCertificateKey,
    };
  }

  return {
    body,
    contentLength: body.length,
    contentType: "application/pdf",
    envelopeId: envelope.id,
    fileName: buildDownloadFileName(envelope, "evidence"),
    fileType: "evidence",
    key: envelope.evidenceKey ?? envelope.id,
  };
}

async function isRecipientAuthorizedForEnvelope(
  signerId: string,
  envelopeId: string,
  database: DbExecutor,
): Promise<boolean> {
  return (await getSignerForEnvelope(signerId, envelopeId, database)) !== null;
}

export async function getSenderEnvelopeDownload(
  userId: string,
  envelopeId: string,
  fileType: unknown,
  {
    database = getDb(),
  }: {
    database?: DbExecutor;
  } = {},
): Promise<EnvelopeDownloadResult> {
  const parsedFileType = downloadFileTypeSchema.parse(fileType);
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);
  const storageService = createStorageService();

  if (!envelope) {
    throw new DownloadAccessError("Envelope not found.", 404);
  }

  if (parsedFileType === "signed") {
    return buildSignedPdfDownload(envelope, database, storageService);
  }

  return buildCertificateDownload(envelope, database, storageService);
}

export async function getPublicEnvelopeDownloadForToken(
  token: string,
  {
    database = getDb(),
  }: {
    database?: DbExecutor;
  } = {},
): Promise<EnvelopeDownloadResult> {
  const storageService = createStorageService();
  const tokenRow = await getRecipientDownloadTokenByHash(
    hashOpaqueToken(token),
    database,
  );
  const now = Math.floor(Date.now() / 1000);

  if (!tokenRow || tokenRow.expiresAt <= now) {
    throw new DownloadAccessError(
      "This download link is invalid or has expired.",
      410,
    );
  }

  const envelope = await getEnvelopeById(tokenRow.envelopeId, database);

  if (!envelope) {
    throw new DownloadAccessError(
      "This download link is invalid or has expired.",
      410,
    );
  }

  if (
    !(await isRecipientAuthorizedForEnvelope(
      tokenRow.signerId,
      envelope.id,
      database,
    ))
  ) {
    throw new DownloadAccessError(
      "This download link is invalid or has expired.",
      410,
    );
  }

  const fileType = downloadFileTypeSchema.parse(tokenRow.fileType);

  if (fileType === "signed") {
    return buildSignedPdfDownload(envelope, database, storageService);
  }

  return buildCertificateDownload(envelope, database, storageService, {
    redactForRecipients: true,
  });
}
