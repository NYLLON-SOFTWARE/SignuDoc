import { randomUUID } from "node:crypto";

import { type Branding } from "./branding.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import {
  envelopeListFiltersSchema,
  type AuditEventRecord,
  envelopeCreateResponseSchema,
  envelopePageSchema,
  envelopeRecordSchema,
  sendEnvelopeResponseSchema,
  voidEnvelopeResponseSchema,
  type CreateEnvelopeResponse,
  type EnvelopeListFilters,
  type EnvelopePageRecord,
  type EnvelopeRecord,
  type SendEnvelopeResponse,
  type VoidEnvelopeResponse,
} from "./schemas/envelope.ts";
import {
  fieldPlacementSchema,
  fieldRecordSchema,
  replaceFieldsResponseSchema,
  replaceFieldsSchema,
  type FieldRecord,
  type ReplaceFieldsResponse,
} from "./schemas/field.ts";
import {
  replaceSignersResponseSchema,
  replaceSignersSchema,
  signerRecordSchema,
  type ReplaceSignersResponse,
  type SignerRecord,
} from "./schemas/signer.ts";
import { getBranding } from "./settings.ts";
import { importPdfDocument } from "./services/document-import.ts";
import {
  listAuditEventsForEnvelope,
  lockEnvelopeAuditChain,
  recordAuditEvent,
  recordEmailSent,
} from "./services/audit.ts";
import { createEmailService } from "./services/email.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import { buildSigningInvitationEmail } from "./services/signing-invitation-email.ts";
import {
  storeEnvelopeCertificatePdf,
  storeRecipientEnvelopeCertificatePdf,
} from "./services/pdf-finalize.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import {
  buildEnvelopeCertificateKey,
  buildEnvelopeOriginalPdfKey,
  buildEnvelopeThumbnailKey,
} from "./services/storage-keys.ts";
import {
  createStorageService,
  StorageObjectNotFoundError,
  type StorageObjectStream,
  type StorageService,
} from "./services/storage.ts";
import {
  assertThumbnailImage,
  THUMBNAIL_CONTENT_TYPE,
} from "./services/thumbnails.ts";
import {
  formatReminderAvailableAt,
  getManualNudgeAvailableAt,
  isManualNudgeAvailable,
} from "./services/reminders.ts";
import { PERMITTED_USE_VERSION } from "./permitted-uses.ts";
import { hashAccessCode } from "./signer-checks.ts";
import { escapeHtml } from "./utils/html.ts";

type CreateDraftEnvelopeOptions = {
  database?: DbPool;
};

type CreateDraftEnvelopeInput = {
  sourcePdf: {
    body: Uint8Array;
    contentType?: string | null;
    filename: string;
  };
  title: string;
};

type SendDraftEnvelopeInput = {
  ipAddress?: string | null;
  senderEmail: string;
  senderName: string;
  userAgent?: string | null;
};

type VoidEnvelopeInput = {
  ipAddress?: string | null;
  senderEmail: string;
  senderName: string;
  userAgent?: string | null;
};

type SendDraftEnvelopeOptions = {
  database?: DbPool;
};

type VoidEnvelopeOptions = {
  database?: DbPool;
};

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

function shouldCountFieldForSignerSummary(
  field: Pick<FieldRecord, "required" | "type">,
): boolean {
  if (field.type === "signature" || field.type === "initials") {
    return true;
  }

  if (field.type === "text") {
    return true;
  }

  if (field.type === "checkbox") {
    return field.required;
  }

  return false;
}

type EnvelopePageRow = {
  envelopeId: string;
  heightPt: number;
  id: string;
  pageNumber: number;
  widthPt: number;
};

type PersistedSignerRecord = SignerRecord & {
  envelopeId: string;
  id: string;
  signOrder: number;
};

type PersistedFieldRecord = FieldRecord & {
  envelopeId: string;
  id: string;
  signerId: string;
};

export type DashboardEnvelopeListItem = {
  contextLine: string;
  createdAtLabel: string;
  id: string;
  searchableEmails: readonly string[];
  status: EnvelopeRecord["status"];
  /** What the status pill says: the status, or how far signing has got. */
  statusLabel: string;
  title: string;
};

type ReviewFieldSummary =
  "Checkbox" | "Date" | "Initials" | "Signature" | "Text";

export type ReviewSignerSummary = {
  email: string;
  fieldSummaries: readonly ReviewFieldSummary[];
  id: string;
  name: string;
  order: number;
};

export type ReviewEnvelopeData = {
  canSend: boolean;
  disabledReason: string | null;
  envelopeId: string;
  filename: string;
  isEmpty: boolean;
  pageCount: number;
  signers: readonly ReviewSignerSummary[];
  sizeLabel: string;
  status: EnvelopeRecord["status"];
  title: string;
};

export type DraftSignerStepSigner = {
  email: string;
  /** Set on the signers step only. */
  hasAccessCode?: boolean;
  id: string;
  name: string;
  order: number;
  requireEmailCode?: boolean;
};

export type DraftSignerStepData = {
  envelopeId: string;
  signers: readonly DraftSignerStepSigner[];
  status: EnvelopeRecord["status"];
};

export type PrepareEnvelopeData = {
  envelopeId: string;
  fields: readonly FieldRecord[];
  pageCount: number;
  pages: readonly EnvelopePageRecord[];
  pdfUrl: string;
  signers: readonly DraftSignerStepSigner[];
  status: EnvelopeRecord["status"];
  title: string;
};

export type EnvelopeDetailSignerView = {
  email: string;
  id: string;
  metaLabel: string;
  name: string;
  order: number;
  status: "declined" | "pending" | "signed" | "waiting";
  statusDateLabel?: string;
};

export type EnvelopeDetailTimelineItem = {
  description: string;
  id: string;
  timestamp: string;
  tone: "accent" | "danger" | "neutral" | "success";
};

export type EnvelopeDetailManualReminderState = {
  canSend: boolean;
  nextAvailableAtLabel: string | null;
};

export type EnvelopeDetailData = {
  createdAtLabel: string;
  envelopeId: string;
  manualReminder: EnvelopeDetailManualReminderState | null;
  signers: readonly EnvelopeDetailSignerView[];
  status: EnvelopeRecord["status"];
  timeline: readonly EnvelopeDetailTimelineItem[];
  title: string;
};

export type DraftEnvelopeDocument = {
  body: Uint8Array;
  contentLength: number;
  contentType: string;
  fileName: string;
};

export class EnvelopeMutationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "EnvelopeMutationError";
    this.statusCode = statusCode;
  }
}

export class EnvelopeDocumentAccessError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "EnvelopeDocumentAccessError";
    this.statusCode = statusCode;
  }
}

export type DraftEnvelopeResult = {
  envelope: EnvelopeRecord;
  pages: EnvelopePageRecord[];
};

export type ReplaceDraftSignersResult = ReplaceSignersResponse;
export type ReplaceDraftFieldsResult = ReplaceFieldsResponse;
export type SendDraftEnvelopeResult = SendEnvelopeResponse;
export type VoidEnvelopeResult = VoidEnvelopeResponse;

const FIELD_TYPE_SUMMARY_LABELS: Record<
  FieldRecord["type"],
  ReviewFieldSummary
> = {
  checkbox: "Checkbox",
  date: "Date",
  initials: "Initials",
  signature: "Signature",
  text: "Text",
};

const FIELD_TYPE_SORT_ORDER: Record<FieldRecord["type"], number> = {
  checkbox: 4,
  date: 2,
  initials: 1,
  signature: 0,
  text: 3,
};

const TIMELINE_TONE_MAP: Record<
  AuditEventRecord["event"],
  EnvelopeDetailTimelineItem["tone"]
> = {
  completed: "success",
  consented: "neutral",
  created: "accent",
  declined: "danger",
  email_sent: "neutral",
  reminded_manual: "neutral",
  sent: "neutral",
  signed: "success",
  verification_failed: "danger",
  verified: "neutral",
  viewed: "neutral",
  voided: "danger",
};

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const longDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

const timelineDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
});

export async function createDraftEnvelope(
  userId: string,
  input: CreateDraftEnvelopeInput,
  { database = getDb() }: CreateDraftEnvelopeOptions = {},
): Promise<DraftEnvelopeResult> {
  const importedPdf = await importPdfDocument({
    body: input.sourcePdf.body,
    contentType: input.sourcePdf.contentType,
    filename: input.sourcePdf.filename,
  });
  const envelopeId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const sourcePdfKey = buildEnvelopeOriginalPdfKey({
    envelopeId,
    userId,
  });
  const storageService = createStorageService();

  await storageService.putObject({
    body: input.sourcePdf.body,
    contentType: "application/pdf",
    key: sourcePdfKey,
  });

  try {
    const envelope = envelopeRecordSchema.parse({
      completedAt: null,
      createdAt: now,
      declinedAt: null,
      evidenceKey: null,
      id: envelopeId,
      pageCount: importedPdf.pageCount,
      sentAt: null,
      signedPdfKey: null,
      sourcePdfFilename: importedPdf.filename,
      sourcePdfHash: importedPdf.sourceHash,
      sourcePdfKey,
      sourcePdfSizeBytes: importedPdf.sizeBytes,
      status: "draft",
      title: input.title,
      updatedAt: now,
      userId,
      voidedAt: null,
    });
    const pages = importedPdf.pages.map((page) =>
      envelopePageSchema.parse({
        envelopeId,
        heightPt: page.heightPt,
        id: randomUUID(),
        pageNumber: page.pageNumber,
        widthPt: page.widthPt,
      }),
    );

    await withTransaction(async (tx) => {
      await tx.query(
        `
          INSERT INTO envelopes (
            id,
            user_id,
            title,
            status,
            source_pdf_key,
            source_pdf_filename,
            source_pdf_size_bytes,
            page_count,
            signed_pdf_key,
            evidence_key,
            source_pdf_hash,
            sent_at,
            completed_at,
            declined_at,
            voided_at,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
          )
        `,
        [
          envelope.id,
          envelope.userId,
          envelope.title,
          envelope.status,
          envelope.sourcePdfKey,
          envelope.sourcePdfFilename,
          envelope.sourcePdfSizeBytes,
          envelope.pageCount,
          envelope.signedPdfKey,
          envelope.evidenceKey,
          envelope.sourcePdfHash,
          envelope.sentAt,
          envelope.completedAt,
          envelope.declinedAt,
          envelope.voidedAt,
          envelope.createdAt,
          envelope.updatedAt,
        ],
      );

      for (const page of pages) {
        await tx.query(
          `
            INSERT INTO envelope_pages (
              id,
              envelope_id,
              page_number,
              width_pt,
              height_pt
            ) VALUES ($1, $2, $3, $4, $5)
          `,
          [
            page.id,
            page.envelopeId,
            page.pageNumber,
            page.widthPt,
            page.heightPt,
          ],
        );
      }

      await recordAuditEvent(
        {
          actorEmail: null,
          actorType: "sender",
          createdAt: now,
          envelopeId,
          event: "created",
          metadata: null,
        },
        tx,
      );
    }, database);

    return {
      envelope,
      pages,
    };
  } catch (error) {
    await storageService.deleteObject(sourcePdfKey).catch(() => undefined);
    throw error;
  }
}

export function buildCreateEnvelopeResponse(
  result: DraftEnvelopeResult,
): CreateEnvelopeResponse {
  return envelopeCreateResponseSchema.parse({
    envelopeId: result.envelope.id,
    pageCount: result.envelope.pageCount,
    redirectPath: `/envelopes/${result.envelope.id}/signers`,
    sourcePdfFilename: result.envelope.sourcePdfFilename,
    sourcePdfSizeBytes: result.envelope.sourcePdfSizeBytes,
    title: result.envelope.title,
  });
}

function mapEnvelopeRow(row: EnvelopeRow): EnvelopeRecord {
  return envelopeRecordSchema.parse(row);
}

function mapSignerRow(row: SignerRow): PersistedSignerRecord {
  return signerRecordSchema.parse(row) as PersistedSignerRecord;
}

function mapEnvelopePageRow(row: EnvelopePageRow): EnvelopePageRecord {
  return envelopePageSchema.parse(row);
}

function mapFieldRow(row: FieldRow): PersistedFieldRecord {
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
  }) as PersistedFieldRecord;
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function buildInClausePlaceholders(length: number, startAt = 1): string {
  return Array.from(
    { length },
    (_, index) => `$${String(index + startAt)}`,
  ).join(", ");
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatShortDate(timestamp: number): string {
  return shortDateFormatter.format(new Date(timestamp * 1000));
}

function formatLongDate(timestamp: number): string {
  return longDateFormatter.format(new Date(timestamp * 1000));
}

function formatTimelineTimestamp(timestamp: number): string {
  return timelineDateFormatter.format(new Date(timestamp * 1000));
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
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
      WHERE id = $1 AND user_id = $2
    `,
    [envelopeId, userId],
  );

  return row ? mapEnvelopeRow(row) : null;
}

async function listSignersForEnvelopeIds(
  envelopeIds: readonly string[],
  database: DbExecutor,
): Promise<Map<string, PersistedSignerRecord[]>> {
  if (envelopeIds.length === 0) {
    return new Map();
  }

  const placeholders = buildInClausePlaceholders(envelopeIds.length);
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
      WHERE envelope_id IN (${placeholders})
      ORDER BY envelope_id ASC, sign_order ASC, id ASC
    `,
    envelopeIds,
  );

  const signersByEnvelope = new Map<string, PersistedSignerRecord[]>();

  for (const row of rows) {
    const signer = mapSignerRow(row);
    const existing = signersByEnvelope.get(signer.envelopeId);

    if (existing) {
      existing.push(signer);
      continue;
    }

    signersByEnvelope.set(signer.envelopeId, [signer]);
  }

  return signersByEnvelope;
}

async function listSignersForEnvelopeId(
  envelopeId: string,
  database: DbExecutor,
): Promise<PersistedSignerRecord[]> {
  return (
    (await listSignersForEnvelopeIds([envelopeId], database)).get(envelopeId) ??
    []
  );
}

async function listSignerCheckSettings(
  envelopeId: string,
  database: DbExecutor,
): Promise<Map<string, { hasAccessCode: boolean; requireEmailCode: boolean }>> {
  const rows = await queryMany<{
    hasAccessCode: boolean;
    id: string;
    requireEmailCode: boolean;
  }>(
    database,
    `
      SELECT
        id,
        access_code_hash IS NOT NULL AS "hasAccessCode",
        require_email_code AS "requireEmailCode"
      FROM signers
      WHERE envelope_id = $1
    `,
    [envelopeId],
  );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        hasAccessCode: Boolean(row.hasAccessCode),
        requireEmailCode: Boolean(row.requireEmailCode),
      },
    ]),
  );
}

async function listEnvelopePagesForEnvelopeId(
  envelopeId: string,
  database: DbExecutor,
): Promise<EnvelopePageRecord[]> {
  const rows = await queryMany<EnvelopePageRow>(
    database,
    `
      SELECT
        id,
        envelope_id AS "envelopeId",
        page_number AS "pageNumber",
        width_pt AS "widthPt",
        height_pt AS "heightPt"
      FROM envelope_pages
      WHERE envelope_id = $1
      ORDER BY page_number ASC, id ASC
    `,
    [envelopeId],
  );

  return rows.map(mapEnvelopePageRow);
}

async function listFieldsForEnvelopeIds(
  envelopeIds: readonly string[],
  database: DbExecutor,
): Promise<Map<string, PersistedFieldRecord[]>> {
  if (envelopeIds.length === 0) {
    return new Map();
  }

  const placeholders = buildInClausePlaceholders(envelopeIds.length);
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
      WHERE envelope_id IN (${placeholders})
      ORDER BY envelope_id ASC, page ASC, created_at ASC, id ASC
    `,
    envelopeIds,
  );

  const fieldsByEnvelope = new Map<string, PersistedFieldRecord[]>();

  for (const row of rows) {
    const field = mapFieldRow(row);
    const existing = fieldsByEnvelope.get(field.envelopeId);

    if (existing) {
      existing.push(field);
      continue;
    }

    fieldsByEnvelope.set(field.envelopeId, [field]);
  }

  return fieldsByEnvelope;
}

function buildDashboardContextLine(
  envelope: EnvelopeRecord,
  signers: readonly PersistedSignerRecord[],
  fields: readonly PersistedFieldRecord[],
): string {
  if (envelope.status === "completed") {
    const sentTo = signers.map((signer) => signer.email).join(", ");
    return sentTo.length > 0 ? `Sent to: ${sentTo}` : "Sent to: —";
  }

  if (envelope.status === "sent") {
    const currentSigner =
      signers.find((signer) => signer.status === "notified") ??
      signers.find((signer) => signer.status === "pending");

    return `Waiting on: ${currentSigner?.email ?? "—"}`;
  }

  if (envelope.status === "declined") {
    const declinedSigner = signers.find(
      (signer) => signer.status === "declined",
    );
    return `Declined by: ${declinedSigner?.email ?? "—"}`;
  }

  if (envelope.status === "voided") {
    return `Voided on ${formatShortDate(envelope.voidedAt ?? envelope.updatedAt)}`;
  }

  return `${pluralize(signers.length, "signer")} · ${pluralize(fields.length, "field")} placed`;
}

const dashboardStatusLabels: Record<EnvelopeRecord["status"], string> = {
  completed: "Completed",
  declined: "Declined",
  draft: "Draft",
  sent: "Sent",
  voided: "Voided",
};

function buildDashboardStatusLabel(
  envelope: EnvelopeRecord,
  signers: readonly PersistedSignerRecord[],
): string {
  // With one signer "Sent" says it all. With several, say how many are done.
  if (envelope.status === "sent" && signers.length > 1) {
    const signedCount = signers.filter(
      (signer) => signer.status === "signed",
    ).length;

    return `${String(signedCount)} of ${String(signers.length)} signed`;
  }

  return dashboardStatusLabels[envelope.status];
}

function buildFieldsBySigner(
  fields: readonly FieldRecord[],
): Map<string, FieldRecord[]> {
  return fields.reduce<Map<string, FieldRecord[]>>((entries, field) => {
    const existing = entries.get(field.signerId);

    if (existing) {
      existing.push(field);
    } else {
      entries.set(field.signerId, [field]);
    }

    return entries;
  }, new Map());
}

function getMissingSignatureSigner(
  signers: readonly PersistedSignerRecord[],
  fieldsBySigner: ReadonlyMap<string, readonly FieldRecord[]>,
): PersistedSignerRecord | undefined {
  return signers.find(
    (signer) =>
      !(fieldsBySigner.get(signer.id) ?? []).some(
        (field) => field.type === "signature",
      ),
  );
}

function buildVoidNotificationEmail(input: {
  branding: Branding;
  envelopeId: string;
  envelopeTitle: string;
  senderName: string;
  signerEmail: string;
  signerName: string;
}) {
  const subject = `"${input.envelopeTitle}" was voided by ${input.senderName}`;
  const textBody = [
    `Hi ${input.signerName},`,
    "",
    `${input.senderName} voided "${input.envelopeTitle}" in ${input.branding.productName}.`,
    "The signing process has been canceled. No further action is needed.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.signerName)},</p>`,
    `<p>${escapeHtml(input.senderName)} voided &ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; in ${escapeHtml(input.branding.productName)}.</p>`,
    "<p>The signing process has been canceled. No further action is needed.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter(
    {
      htmlBody,
      textBody,
    },
    input.branding,
  );

  return {
    htmlBody: legalFooter.htmlBody,
    subject,
    template: "void_notification" as const,
    textBody: legalFooter.textBody,
    to: input.signerEmail,
  };
}

function buildTimelineDescription(event: AuditEventRecord): string {
  const signerName =
    typeof event.metadata?.signerName === "string"
      ? event.metadata.signerName
      : null;
  const signerEmail =
    typeof event.metadata?.signerEmail === "string"
      ? event.metadata.signerEmail
      : null;
  const declineReason =
    typeof event.metadata?.reason === "string" &&
    event.metadata.reason.trim().length > 0
      ? event.metadata.reason.trim()
      : null;
  const targetLabel = signerName ?? event.actorEmail ?? signerEmail ?? "signer";

  switch (event.event) {
    case "created":
      return "Envelope created";
    case "sent":
      return `Sent to ${targetLabel}`;
    case "viewed":
      return `Viewed by ${targetLabel}`;
    case "signed":
      return `Signed by ${targetLabel}`;
    case "declined":
      return declineReason
        ? `Declined by ${targetLabel} — ${declineReason}`
        : `Declined by ${targetLabel}`;
    case "reminded_manual":
      return `Manual reminder sent to ${targetLabel}`;
    case "consented":
      return `${targetLabel} agreed to use electronic records and signatures`;
    case "verified":
      return `${targetLabel} confirmed their identity`;
    case "verification_failed":
      return `Wrong identity code entered for ${targetLabel}`;
    case "email_sent":
      return typeof event.metadata?.recipient === "string"
        ? `Email accepted for delivery to ${event.metadata.recipient}`
        : "Email accepted for delivery";
    case "completed":
      return "Final signed PDF and certificate generated";
    case "voided":
      return "Envelope voided by sender";
    default:
      return event.event;
  }
}

function buildDetailSignerStatusLabel(
  envelope: EnvelopeRecord,
  signer: PersistedSignerRecord,
  previousSignerName?: string,
): string | undefined {
  if (signer.status === "signed" && signer.signedAt) {
    return `Signed ${formatShortDate(signer.signedAt)}`;
  }

  if (signer.status === "declined" && signer.declinedAt) {
    return `Declined ${formatShortDate(signer.declinedAt)}`;
  }

  if (signer.status === "notified") {
    const sentAt = signer.lastNotifiedAt ?? signer.turnStartedAt;
    if (envelope.status === "voided") {
      return sentAt
        ? `Notified ${formatShortDate(sentAt)}`
        : "Notified before void";
    }

    return sentAt ? `Sent ${formatShortDate(sentAt)}` : undefined;
  }

  if (envelope.status === "draft") {
    return previousSignerName
      ? `Ready to notify after ${previousSignerName}`
      : "Ready to notify after send";
  }

  return "No notification sent";
}

function buildDetailSignerMetaLabel(
  envelope: EnvelopeRecord,
  signer: PersistedSignerRecord,
  assignedFieldCount: number,
): string {
  if (envelope.status === "voided" && signer.status === "notified") {
    return "Last notified signer before void";
  }

  if (signer.status === "declined" && signer.declineReason) {
    return `Decline reason: ${signer.declineReason}`;
  }

  if (envelope.status === "declined" && signer.status === "pending") {
    return "Skipped after decline";
  }

  if (envelope.status === "voided" && signer.status === "pending") {
    return "Not reached before void";
  }

  if (signer.status === "signed") {
    return `${pluralize(assignedFieldCount, "field")} completed`;
  }

  if (signer.status === "notified") {
    return "Current signer";
  }

  return `${pluralize(assignedFieldCount, "field")} assigned`;
}

export async function listEnvelopesForUser(
  userId: string,
  filters: Partial<EnvelopeListFilters> = {},
  database: DbExecutor = getDb(),
): Promise<DashboardEnvelopeListItem[]> {
  const parsedFilters = envelopeListFiltersSchema.parse(filters);
  const values: unknown[] = [userId];
  const clauses = ["user_id = $1"];
  let nextParamIndex = 2;

  if (parsedFilters.status) {
    clauses.push(`status = $${String(nextParamIndex)}`);
    values.push(parsedFilters.status);
    nextParamIndex += 1;
  }

  if (parsedFilters.search) {
    const searchPlaceholder = `$${String(nextParamIndex)}`;
    clauses.push(
      `(
        lower(title) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM signers
          WHERE signers.envelope_id = envelopes.id
            AND lower(signers.email) LIKE ${searchPlaceholder} ESCAPE '\\'
        )
      )`,
    );
    values.push(`%${escapeLike(parsedFilters.search.toLowerCase())}%`);
    nextParamIndex += 1;
  }

  const limitPlaceholder = `$${String(nextParamIndex)}`;
  values.push(parsedFilters.limit);
  nextParamIndex += 1;
  const offsetPlaceholder = `$${String(nextParamIndex)}`;
  values.push((parsedFilters.page - 1) * parsedFilters.limit);

  const rows = await queryMany<EnvelopeRow>(
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
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `,
    values,
  );

  const envelopes = rows.map(mapEnvelopeRow);
  const envelopeIds = envelopes.map((envelope) => envelope.id);
  const [signersByEnvelope, fieldsByEnvelope] = await Promise.all([
    listSignersForEnvelopeIds(envelopeIds, database),
    listFieldsForEnvelopeIds(envelopeIds, database),
  ]);

  return envelopes.map((envelope) => {
    const signers = signersByEnvelope.get(envelope.id) ?? [];
    const fields = fieldsByEnvelope.get(envelope.id) ?? [];

    return {
      contextLine: buildDashboardContextLine(envelope, signers, fields),
      createdAtLabel: formatShortDate(envelope.createdAt),
      id: envelope.id,
      searchableEmails: signers.map((signer) => signer.email),
      status: envelope.status,
      statusLabel: buildDashboardStatusLabel(envelope, signers),
      title: envelope.title,
    };
  });
}

export async function getEnvelopeDetailDataForUser(
  userId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<EnvelopeDetailData | null> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    return null;
  }

  const [signersByEnvelope, fieldsByEnvelope, auditEvents] = await Promise.all([
    listSignersForEnvelopeIds([envelopeId], database),
    listFieldsForEnvelopeIds([envelopeId], database),
    listAuditEventsForEnvelope(envelopeId, database),
  ]);
  const signers = signersByEnvelope.get(envelopeId) ?? [];
  const fields = fieldsByEnvelope.get(envelopeId) ?? [];
  const fieldCountsBySigner = fields.reduce<Map<string, number>>(
    (counts, field) => {
      if (!shouldCountFieldForSignerSummary(field)) {
        return counts;
      }

      counts.set(field.signerId, (counts.get(field.signerId) ?? 0) + 1);
      return counts;
    },
    new Map(),
  );
  const timeline = auditEvents.map((event) => ({
    description: buildTimelineDescription(event),
    id: event.id,
    timestamp: formatTimelineTimestamp(event.createdAt),
    tone: TIMELINE_TONE_MAP[event.event],
  }));

  const signerViews = signers.map((signer, index) => {
    const previousSignerName = index > 0 ? signers[index - 1]?.name : undefined;
    const signerStatus: EnvelopeDetailSignerView["status"] =
      signer.status === "notified" ? "waiting" : signer.status;

    return {
      email: signer.email,
      id: signer.id,
      metaLabel: buildDetailSignerMetaLabel(
        envelope,
        signer,
        fieldCountsBySigner.get(signer.id) ?? 0,
      ),
      name: signer.name,
      order: signer.signOrder,
      status: signerStatus,
      statusDateLabel: buildDetailSignerStatusLabel(
        envelope,
        signer,
        previousSignerName,
      ),
    };
  });
  const currentSigner = signers.find((signer) => signer.status === "notified");
  let manualReminder: EnvelopeDetailManualReminderState | null = null;

  if (envelope.status === "sent" && currentSigner) {
    const nowUnixTimestamp = Math.floor(Date.now() / 1000);
    const nextAvailableAt =
      typeof currentSigner.lastNudgedAt === "number"
        ? getManualNudgeAvailableAt(currentSigner.lastNudgedAt)
        : null;
    const canSend = isManualNudgeAvailable(
      currentSigner.lastNudgedAt,
      nowUnixTimestamp,
    );

    manualReminder = {
      canSend,
      nextAvailableAtLabel:
        !canSend && typeof nextAvailableAt === "number"
          ? formatReminderAvailableAt(nextAvailableAt)
          : null,
    };
  }

  return {
    createdAtLabel: formatLongDate(envelope.createdAt),
    envelopeId,
    manualReminder,
    signers: signerViews,
    status: envelope.status,
    timeline,
    title: envelope.title,
  };
}

export async function getDraftSignerStepDataForUser(
  userId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<DraftSignerStepData | null> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    return null;
  }

  const checks = await listSignerCheckSettings(envelopeId, database);

  return {
    envelopeId,
    signers: (await listSignersForEnvelopeId(envelopeId, database)).map(
      (signer) => ({
        email: signer.email,
        hasAccessCode: checks.get(signer.id)?.hasAccessCode ?? false,
        id: signer.id,
        name: signer.name,
        order: signer.signOrder,
        requireEmailCode: checks.get(signer.id)?.requireEmailCode ?? false,
      }),
    ),
    status: envelope.status,
  };
}

export async function getDraftEnvelopeDocumentForUser(
  userId: string,
  envelopeId: string,
  {
    database = getDb(),
  }: {
    database?: DbExecutor;
  } = {},
): Promise<DraftEnvelopeDocument> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeDocumentAccessError("Envelope not found.", 404);
  }

  const storageService = createStorageService();

  try {
    const object = await storageService.getObject(envelope.sourcePdfKey);

    return {
      body: object.body,
      contentLength: object.contentLength ?? object.body.length,
      contentType: object.contentType ?? "application/pdf",
      fileName: envelope.sourcePdfFilename,
    };
  } catch (error) {
    if (
      error instanceof StorageObjectNotFoundError ||
      (error instanceof Error &&
        (error.name === "NoSuchKey" || error.name === "NotFound"))
    ) {
      throw new EnvelopeDocumentAccessError("Source PDF is unavailable.", 404);
    }

    throw error;
  }
}

/**
 * Keeps the picture of the first page that the sender's browser drew. The
 * bytes are checked before they are stored: see services/thumbnails.ts.
 */
export async function saveEnvelopeThumbnailForUser(
  userId: string,
  envelopeId: string,
  body: Uint8Array,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: {
    database?: DbExecutor;
    storageService?: StorageService;
  } = {},
): Promise<void> {
  assertThumbnailImage(body);

  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeDocumentAccessError("Envelope not found.", 404);
  }

  const key = buildEnvelopeThumbnailKey({
    envelopeId: envelope.id,
    sourcePdfKey: envelope.sourcePdfKey,
    userId,
  });

  await storageService.putObject({
    body,
    contentType: THUMBNAIL_CONTENT_TYPE,
    key,
  });

  // The envelope may have been deleted while the picture was being written:
  // by its owner, by the cleanup job or with the whole account. Each of
  // those removes the row first and the files after, so a row that is still
  // here now will have this picture removed with it. A row that is gone has
  // already had its files removed, and nothing would ever come back for this
  // one.
  const envelopeAfterWrite = await getEnvelopeByIdForUser(
    userId,
    envelopeId,
    database,
  );

  if (!envelopeAfterWrite) {
    await storageService.deleteObject(key);

    throw new EnvelopeDocumentAccessError("Envelope not found.", 404);
  }
}

/** Streams the stored first-page picture, or says there is none (404). */
export async function getEnvelopeThumbnailForUser(
  userId: string,
  envelopeId: string,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: {
    database?: DbExecutor;
    storageService?: StorageService;
  } = {},
): Promise<StorageObjectStream> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeDocumentAccessError("Envelope not found.", 404);
  }

  try {
    return await storageService.getObjectStream(
      buildEnvelopeThumbnailKey({
        envelopeId: envelope.id,
        sourcePdfKey: envelope.sourcePdfKey,
        userId,
      }),
    );
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new EnvelopeDocumentAccessError(
        "This document has no thumbnail yet.",
        404,
      );
    }

    throw error;
  }
}

export async function getPrepareEnvelopeDataForUser(
  userId: string,
  envelopeId: string,
  {
    database = getDb(),
  }: {
    database?: DbExecutor;
  } = {},
): Promise<PrepareEnvelopeData | null> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    return null;
  }

  const [fieldsByEnvelope, pages, signers] = await Promise.all([
    listFieldsForEnvelopeIds([envelopeId], database),
    listEnvelopePagesForEnvelopeId(envelopeId, database),
    listSignersForEnvelopeId(envelopeId, database),
  ]);

  return {
    envelopeId,
    fields: fieldsByEnvelope.get(envelopeId) ?? [],
    pageCount: envelope.pageCount,
    pages,
    pdfUrl: `/api/envelopes/${encodeURIComponent(envelopeId)}/document`,
    signers: signers.map((signer) => ({
      email: signer.email,
      id: signer.id,
      name: signer.name,
      order: signer.signOrder,
    })),
    status: envelope.status,
    title: envelope.title,
  };
}

export async function getReviewEnvelopeDataForUser(
  userId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<ReviewEnvelopeData | null> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    return null;
  }

  const [signersByEnvelope, fieldsByEnvelope] = await Promise.all([
    listSignersForEnvelopeIds([envelopeId], database),
    listFieldsForEnvelopeIds([envelopeId], database),
  ]);
  const signers = signersByEnvelope.get(envelopeId) ?? [];
  const fields = fieldsByEnvelope.get(envelopeId) ?? [];
  const fieldsBySigner = buildFieldsBySigner(fields);
  const missingSignatureSigner = getMissingSignatureSigner(
    signers,
    fieldsBySigner,
  );
  const isEmpty = signers.length === 0 || fields.length === 0;

  return {
    canSend: !isEmpty && !missingSignatureSigner,
    disabledReason: missingSignatureSigner
      ? `Every signer must have at least one Signature field before sending. ${missingSignatureSigner.name} is missing one.`
      : null,
    envelopeId,
    filename: envelope.sourcePdfFilename,
    isEmpty,
    pageCount: envelope.pageCount,
    signers: signers.map((signer) => ({
      email: signer.email,
      fieldSummaries: (fieldsBySigner.get(signer.id) ?? [])
        .slice()
        .sort(
          (left, right) =>
            FIELD_TYPE_SORT_ORDER[left.type] -
            FIELD_TYPE_SORT_ORDER[right.type],
        )
        .map((field) => FIELD_TYPE_SUMMARY_LABELS[field.type]),
      id: signer.id,
      name: signer.name,
      order: signer.signOrder,
    })),
    sizeLabel: formatFileSize(envelope.sourcePdfSizeBytes),
    status: envelope.status,
    title: envelope.title,
  };
}

export async function sendDraftEnvelope(
  userId: string,
  envelopeId: string,
  input: SendDraftEnvelopeInput,
  { database = getDb() }: SendDraftEnvelopeOptions = {},
): Promise<SendDraftEnvelopeResult> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.status !== "draft") {
    throw new EnvelopeMutationError("Only draft envelopes can be sent.", 409);
  }

  const signers = await listSignersForEnvelopeId(envelopeId, database);
  const fields =
    (await listFieldsForEnvelopeIds([envelopeId], database)).get(envelopeId) ??
    [];

  if (signers.length === 0 || fields.length === 0) {
    throw new EnvelopeMutationError(
      "Add signers and place fields before sending this envelope.",
      400,
    );
  }

  const signerIds = new Set(signers.map((signer) => signer.id));

  if (fields.some((field) => !signerIds.has(field.signerId))) {
    throw new EnvelopeMutationError(
      "Each field must be assigned to an existing signer on this envelope.",
      400,
    );
  }

  const missingSignatureSigner = getMissingSignatureSigner(
    signers,
    buildFieldsBySigner(fields),
  );

  if (missingSignatureSigner) {
    throw new EnvelopeMutationError(
      `Every signer must have at least one Signature field before sending. ${missingSignatureSigner.name} is missing one.`,
      400,
    );
  }

  const firstSigner = signers[0];

  if (!firstSigner) {
    throw new EnvelopeMutationError(
      "Add signers before sending this envelope.",
      400,
    );
  }

  const emailService = createEmailService();
  const storageService = createStorageService();
  const sourcePdfHead = await storageService.headObject(envelope.sourcePdfKey);

  if (!sourcePdfHead.exists) {
    throw new EnvelopeMutationError(
      "The source document for this envelope could not be found.",
      500,
    );
  }

  const sentAt = Math.floor(Date.now() / 1000);
  const sentAuditAt = Math.max(sentAt, envelope.createdAt + 1);
  const issuedLink = await issueSigningLink({
    issuedAt: sentAt,
  });

  try {
    await withTransaction(async (tx) => {
      const updatedEnvelope = await tx.query(
        `
          UPDATE envelopes
          SET
            status = 'sent',
            sent_at = $1,
            updated_at = $2
          WHERE id = $3
            AND user_id = $4
            AND status = 'draft'
        `,
        [sentAt, sentAt, envelopeId, userId],
      );

      if (updatedEnvelope.rowCount !== 1) {
        throw new EnvelopeMutationError(
          "This envelope has already been sent.",
          409,
        );
      }

      await tx.query(
        `
          UPDATE signers
          SET
            status = 'pending',
            signing_token_hash = NULL,
            signing_token_expires_at = NULL,
            turn_started_at = NULL,
            last_notified_at = NULL,
            last_nudged_at = NULL,
            signed_at = NULL,
            declined_at = NULL,
            decline_reason = NULL,
            updated_at = $1
          WHERE envelope_id = $2
        `,
        [sentAt, envelopeId],
      );

      const updatedSigner = await tx.query(
        `
          UPDATE signers
          SET
            status = 'notified',
            signing_token_hash = $1,
            signing_token_expires_at = $2,
            turn_started_at = $3,
            last_notified_at = $4,
            updated_at = $5
          WHERE id = $6
            AND envelope_id = $7
        `,
        [
          issuedLink.tokenHash,
          issuedLink.exp,
          sentAt,
          sentAt,
          sentAt,
          firstSigner.id,
          envelopeId,
        ],
      );

      if (updatedSigner.rowCount !== 1) {
        throw new EnvelopeMutationError(
          "Unable to activate the first signer for this envelope.",
          500,
        );
      }

      await recordAuditEvent(
        {
          actorEmail: input.senderEmail,
          actorType: "sender",
          createdAt: sentAuditAt,
          envelopeId,
          event: "sent",
          ipAddress: input.ipAddress ?? null,
          metadata: {
            // The send route refuses a send without this confirmation.
            permittedUseConfirmed: true,
            permittedUseVersion: PERMITTED_USE_VERSION,
            signerEmail: firstSigner.email,
            signerId: firstSigner.id,
            signerName: firstSigner.name,
          },
          userAgent: input.userAgent ?? null,
        },
        tx,
      );
    }, database);
  } catch (error) {
    throw error;
  }

  let invitationMessageId: string | undefined;

  try {
    invitationMessageId = (
      await emailService.send(
        buildSigningInvitationEmail({
          branding: await getBranding(),
          envelopeTitle: envelope.title,
          senderName: input.senderName,
          signerEmail: firstSigner.email,
          signerName: firstSigner.name,
          signingUrl: issuedLink.url,
        }),
      )
    ).messageId;
  } catch (error) {
    await withTransaction(async (tx) => {
      await tx.query(
        `
          UPDATE envelopes
          SET
            status = 'draft',
            sent_at = NULL,
            updated_at = $1
          WHERE id = $2
            AND user_id = $3
            AND status = 'sent'
        `,
        [envelope.updatedAt, envelopeId, userId],
      );

      await tx.query(
        `
          UPDATE signers
          SET
            status = 'pending',
            signing_token_hash = NULL,
            signing_token_expires_at = NULL,
            turn_started_at = NULL,
            last_notified_at = NULL,
            last_nudged_at = NULL,
            signed_at = NULL,
            declined_at = NULL,
            decline_reason = NULL,
            updated_at = $1
          WHERE envelope_id = $2
        `,
        [envelope.updatedAt, envelopeId],
      );

      await lockEnvelopeAuditChain(envelopeId, tx);
      await tx.query(
        `
          DELETE FROM audit_events
          WHERE envelope_id = $1
            AND event = 'sent'
            AND created_at = $2
            AND actor_email = $3
            -- Only while it is still the newest link of the audit chain: an
            -- event recorded after it (say, the invitation was opened before
            -- the send failed) chains to it, so it stays as history.
            AND sequence = (
              SELECT max(sequence) FROM audit_events WHERE envelope_id = $1
            )
        `,
        [envelopeId, sentAuditAt, input.senderEmail],
      );
    }, database).catch((rollbackError) => {
      console.error(
        `Failed to roll back sent envelope ${envelopeId} after email delivery failure:`,
        rollbackError,
      );
    });

    throw error;
  }

  await recordEmailSent(
    {
      envelopeId,
      messageId: invitationMessageId,
      recipient: firstSigner.email,
      signerId: firstSigner.id,
      template: "signing_invitation",
    },
    database,
  );

  return sendEnvelopeResponseSchema.parse({
    envelopeId,
    notifiedSignerName: firstSigner.name,
    redirectPath: `/envelopes/${envelopeId}`,
    sentAt,
  });
}

export async function voidSentEnvelope(
  userId: string,
  envelopeId: string,
  input: VoidEnvelopeInput,
  { database = getDb() }: VoidEnvelopeOptions = {},
): Promise<VoidEnvelopeResult> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.status !== "sent") {
    throw new EnvelopeMutationError("Only sent envelopes can be voided.", 409);
  }

  const signers = await listSignersForEnvelopeId(envelopeId, database);
  const notifiedSigners = signers.filter(
    (signer) => signer.status === "notified",
  );
  const currentSigner = notifiedSigners[0];
  const voidedAt = Math.floor(Date.now() / 1000);
  const emailService = createEmailService();
  const storageService = createStorageService();
  const sourcePdfHead = await storageService.headObject(envelope.sourcePdfKey);

  if (!sourcePdfHead.exists) {
    throw new EnvelopeMutationError(
      "The source document for this envelope could not be found.",
      500,
    );
  }

  const voidedAuditEvent: AuditEventRecord = {
    actorEmail: input.senderEmail,
    actorType: "sender",
    createdAt: voidedAt,
    envelopeId,
    event: "voided",
    id: randomUUID(),
    ipAddress: input.ipAddress ?? null,
    metadata: currentSigner
      ? {
          signerEmail: currentSigner.email,
          signerId: currentSigner.id,
          signerName: currentSigner.name,
          signerOrder: currentSigner.signOrder,
        }
      : null,
    userAgent: input.userAgent ?? null,
  };
  const storageIdentity = {
    envelopeId,
    userId,
  };
  const canonicalCertificate = {
    bucketName: sourcePdfHead.bucketName,
    key: buildEnvelopeCertificateKey({
      ...storageIdentity,
      audience: "internal",
    }),
  };
  const voidedEnvelope = envelopeRecordSchema.parse({
    ...envelope,
    evidenceKey: canonicalCertificate.key,
    status: "voided",
    updatedAt: voidedAt,
    voidedAt,
  });
  const voidedSigners = signers.map((signer) =>
    signer.status === "notified"
      ? signerRecordSchema.parse({
          ...signer,
          signingTokenExpiresAt: null,
          signingTokenHash: null,
          updatedAt: voidedAt,
        })
      : signer,
  );
  const auditEvents = [
    ...(await listAuditEventsForEnvelope(envelopeId, database)),
    voidedAuditEvent,
  ];
  const storedCertificateKeys: string[] = [];
  let certificate: { key: string; sha256: string };
  let recipientCertificateSha256: string;

  try {
    certificate = await storeEnvelopeCertificatePdf(
      {
        auditEvents,
        certificate: canonicalCertificate,
        envelope: voidedEnvelope,
        signers: voidedSigners,
      },
      {
        storageService,
      },
    );
    storedCertificateKeys.push(certificate.key);

    const recipientCertificate = await storeRecipientEnvelopeCertificatePdf(
      {
        auditEvents,
        certificate: {
          bucketName: sourcePdfHead.bucketName,
          key: buildEnvelopeCertificateKey({
            ...storageIdentity,
            audience: "recipient",
          }),
        },
        envelope: voidedEnvelope,
        signers: voidedSigners,
      },
      {
        storageService,
      },
    );
    storedCertificateKeys.push(recipientCertificate.key);
    recipientCertificateSha256 = recipientCertificate.sha256;
  } catch (error) {
    await Promise.all(
      storedCertificateKeys.map((key) =>
        storageService.deleteObject(key).catch(() => undefined),
      ),
    );
    throw error;
  }

  try {
    await withTransaction(async (tx) => {
      const persistedEnvelope = await getEnvelopeByIdForUser(
        userId,
        envelopeId,
        tx,
      );

      if (!persistedEnvelope) {
        throw new EnvelopeMutationError("Envelope not found.", 404);
      }

      if (persistedEnvelope.status !== "sent") {
        throw new EnvelopeMutationError(
          "Only sent envelopes can be voided.",
          409,
        );
      }

      const updatedEnvelope = await tx.query(
        `
          UPDATE envelopes
          SET
            status = 'voided',
            evidence_key = $1,
            voided_at = $2,
            updated_at = $3,
            evidence_sha256 = $6,
            recipient_evidence_sha256 = $7
          WHERE id = $4
            AND user_id = $5
            AND status = 'sent'
        `,
        [
          certificate.key,
          voidedAt,
          voidedAt,
          envelopeId,
          userId,
          certificate.sha256,
          recipientCertificateSha256,
        ],
      );

      if (updatedEnvelope.rowCount !== 1) {
        throw new EnvelopeMutationError(
          "This envelope can no longer be voided.",
          409,
        );
      }

      await tx.query(
        `
          UPDATE signers
          SET
            signing_token_hash = NULL,
            signing_token_expires_at = NULL,
            updated_at = $1
          WHERE envelope_id = $2
            AND status = 'notified'
        `,
        [voidedAt, envelopeId],
      );

      await recordAuditEvent(
        {
          actorEmail: voidedAuditEvent.actorEmail,
          actorType: voidedAuditEvent.actorType,
          id: voidedAuditEvent.id,
          createdAt: voidedAuditEvent.createdAt,
          envelopeId: voidedAuditEvent.envelopeId,
          event: voidedAuditEvent.event,
          ipAddress: voidedAuditEvent.ipAddress,
          metadata: voidedAuditEvent.metadata,
          userAgent: voidedAuditEvent.userAgent,
        },
        tx,
      );
    }, database);
  } catch (error) {
    await Promise.all(
      storedCertificateKeys.map((key) =>
        storageService.deleteObject(key).catch(() => undefined),
      ),
    );
    throw error;
  }

  const branding = await getBranding().catch(() => null);

  await Promise.all(
    notifiedSigners.map(async (signer) => {
      try {
        if (!branding) {
          throw new Error(
            "Could not load settings for the notification email.",
          );
        }

        const delivery = await emailService.send(
          buildVoidNotificationEmail({
            branding,
            envelopeId,
            envelopeTitle: envelope.title,
            senderName: input.senderName,
            signerEmail: signer.email,
            signerName: signer.name,
          }),
        );

        await recordEmailSent(
          {
            envelopeId,
            messageId: delivery.messageId,
            recipient: signer.email,
            signerId: signer.id,
            template: "void_notification",
          },
          database,
        );
      } catch (error) {
        console.error(
          `Failed to send void notification for envelope ${envelopeId} to ${signer.email}:`,
          error,
        );
      }
    }),
  );

  return voidEnvelopeResponseSchema.parse({
    envelopeId,
    redirectPath: `/envelopes/${envelopeId}`,
    voidedAt,
  });
}

export async function replaceDraftEnvelopeFields(
  userId: string,
  envelopeId: string,
  input: unknown,
  database: DbPool = getDb(),
): Promise<ReplaceDraftFieldsResult> {
  const parsedInput = replaceFieldsSchema.parse(input);
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.status !== "draft") {
    throw new EnvelopeMutationError(
      "Only draft envelopes can be updated.",
      409,
    );
  }

  const [signers, pages, existingFieldsByEnvelope] = await Promise.all([
    listSignersForEnvelopeId(envelopeId, database),
    listEnvelopePagesForEnvelopeId(envelopeId, database),
    listFieldsForEnvelopeIds([envelopeId], database),
  ]);
  const signerIds = new Set(signers.map((signer) => signer.id));
  const pageNumbers = new Set(pages.map((page) => page.pageNumber));
  const existingFields = existingFieldsByEnvelope.get(envelopeId) ?? [];
  const existingFieldMetadata = new Map(
    existingFields.map((field) => [field.id, field.createdAt] as const),
  );
  const usedFieldIds = new Set<string>();
  const updatedAt = Math.floor(Date.now() / 1000);
  const nextFields = parsedInput.fields.map((field, index) => {
    const parsedField = fieldPlacementSchema.parse(field);

    if (!signerIds.has(parsedField.signerId)) {
      throw new EnvelopeMutationError(
        "Each field must be assigned to an existing signer on this envelope.",
        400,
      );
    }

    if (!pageNumbers.has(parsedField.page)) {
      throw new EnvelopeMutationError(
        "Each field must be placed on an existing page in this document.",
        400,
      );
    }

    const fieldId = parsedField.id ?? randomUUID();

    if (usedFieldIds.has(fieldId)) {
      throw new EnvelopeMutationError("Each field must be unique.", 400);
    }

    usedFieldIds.add(fieldId);

    return {
      ...parsedField,
      createdAt: existingFieldMetadata.get(fieldId) ?? updatedAt + index,
      id: fieldId,
      updatedAt,
    };
  });

  await withTransaction(async (tx) => {
    await tx.query(
      `
        DELETE FROM fields
        WHERE envelope_id = $1
      `,
      [envelopeId],
    );

    for (const field of nextFields) {
      await tx.query(
        `
          INSERT INTO fields (
            id,
            envelope_id,
            signer_id,
            type,
            page,
            x,
            y,
            width,
            height,
            required,
            label,
            input_method,
            value,
            image_key,
            checked,
            submitted_at,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL, NULL, NULL, NULL, $12, $13
          )
        `,
        [
          field.id,
          envelopeId,
          field.signerId,
          field.type,
          field.page,
          field.x,
          field.y,
          field.width,
          field.height,
          field.required,
          field.label ?? null,
          field.createdAt,
          field.updatedAt,
        ],
      );
    }

    await tx.query(
      `
        UPDATE envelopes
        SET updated_at = $1
        WHERE id = $2 AND user_id = $3
      `,
      [updatedAt, envelopeId, userId],
    );
  }, database);

  return replaceFieldsResponseSchema.parse({
    envelopeId,
    fields:
      (await listFieldsForEnvelopeIds([envelopeId], database)).get(
        envelopeId,
      ) ?? [],
    redirectPath: `/envelopes/${envelopeId}/review`,
    updatedAt,
  }) as ReplaceDraftFieldsResult;
}

export async function replaceDraftEnvelopeSigners(
  userId: string,
  envelopeId: string,
  input: unknown,
  database: DbPool = getDb(),
): Promise<ReplaceDraftSignersResult> {
  const parsedInput = replaceSignersSchema.parse(input);
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.status !== "draft") {
    throw new EnvelopeMutationError(
      "Only draft envelopes can be updated.",
      409,
    );
  }

  const existingSigners = await listSignersForEnvelopeId(envelopeId, database);
  const existingSignerIds = new Set(existingSigners.map((signer) => signer.id));
  const usedSignerIds = new Set<string>();
  const updatedAt = Math.floor(Date.now() / 1000);
  const nextSigners = parsedInput.signers.map((signer, index) => {
    const persistedSignerId =
      signer.id && existingSignerIds.has(signer.id) ? signer.id : randomUUID();

    if (usedSignerIds.has(persistedSignerId)) {
      throw new EnvelopeMutationError("Each signer must be unique.", 400);
    }

    usedSignerIds.add(persistedSignerId);

    return {
      // undefined keeps the saved hash; null clears it.
      accessCodeHash:
        signer.accessCode === undefined
          ? undefined
          : signer.accessCode === null
            ? null
            : hashAccessCode(signer.accessCode),
      email: signer.email,
      id: persistedSignerId,
      name: signer.name,
      requireEmailCode: signer.requireEmailCode,
      signOrder: index + 1,
    };
  });

  await withTransaction(async (tx) => {
    if (existingSigners.length > 0) {
      await tx.query(
        `
          UPDATE signers
          SET
            email = id || '@temp.invalid',
            sign_order = sign_order + 1000,
            updated_at = $1
          WHERE envelope_id = $2
        `,
        [updatedAt, envelopeId],
      );
    }

    for (const signer of nextSigners) {
      if (existingSignerIds.has(signer.id)) {
        await tx.query(
          `
            UPDATE signers
            SET
              name = $1,
              email = $2,
              sign_order = $3,
              updated_at = $4,
              access_code_hash = CASE WHEN $7::boolean THEN $8 ELSE access_code_hash END,
              require_email_code = COALESCE($9, require_email_code)
            WHERE id = $5 AND envelope_id = $6
          `,
          [
            signer.name,
            signer.email,
            signer.signOrder,
            updatedAt,
            signer.id,
            envelopeId,
            signer.accessCodeHash !== undefined,
            signer.accessCodeHash ?? null,
            signer.requireEmailCode ?? null,
          ],
        );
      } else {
        await tx.query(
          `
            INSERT INTO signers (
              id,
              envelope_id,
              name,
              email,
              sign_order,
              status,
              signing_token_hash,
              signing_token_expires_at,
              turn_started_at,
              last_notified_at,
              last_nudged_at,
              signed_at,
              declined_at,
              decline_reason,
              created_at,
              updated_at,
              access_code_hash,
              require_email_code
            ) VALUES (
              $1, $2, $3, $4, $5, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $6, $7, $8, $9
            )
          `,
          [
            signer.id,
            envelopeId,
            signer.name,
            signer.email,
            signer.signOrder,
            updatedAt,
            updatedAt,
            signer.accessCodeHash ?? null,
            signer.requireEmailCode ?? false,
          ],
        );
      }
    }

    await tx.query(
      `
        DELETE FROM signers
        WHERE envelope_id = $1
          AND id NOT IN (${buildInClausePlaceholders(nextSigners.length, 2)})
      `,
      [envelopeId, ...nextSigners.map((signer) => signer.id)],
    );

    await tx.query(
      `
        UPDATE envelopes
        SET updated_at = $1
        WHERE id = $2 AND user_id = $3
      `,
      [updatedAt, envelopeId, userId],
    );
  }, database);

  const checks = await listSignerCheckSettings(envelopeId, database);

  return replaceSignersResponseSchema.parse({
    envelopeId,
    redirectPath: `/envelopes/${envelopeId}/prepare`,
    signers: (await listSignersForEnvelopeId(envelopeId, database)).map(
      (signer) => ({
        email: signer.email,
        hasAccessCode: checks.get(signer.id)?.hasAccessCode ?? false,
        id: signer.id,
        name: signer.name,
        requireEmailCode: checks.get(signer.id)?.requireEmailCode ?? false,
        signOrder: signer.signOrder,
      }),
    ),
    updatedAt,
  }) as ReplaceDraftSignersResult;
}

export async function deleteDraftEnvelope(
  userId: string,
  envelopeId: string,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: {
    database?: DbExecutor;
    storageService?: StorageService;
  } = {},
): Promise<EnvelopeRecord> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.status !== "draft") {
    throw new EnvelopeMutationError(
      "Only draft envelopes can be deleted.",
      409,
    );
  }

  const deleteResult = await database.query(
    `
      DELETE FROM envelopes
      WHERE id = $1 AND user_id = $2 AND status = 'draft'
    `,
    [envelopeId, userId],
  );

  if (deleteResult.rowCount !== 1) {
    throw new EnvelopeMutationError(
      "This draft envelope can no longer be deleted.",
      409,
    );
  }

  await storageService.deleteObject(envelope.sourcePdfKey).catch((error) => {
    console.error(
      `Failed to delete source PDF for draft envelope ${envelopeId}:`,
      error,
    );
  });
  await storageService
    .deleteObject(
      buildEnvelopeThumbnailKey({
        envelopeId,
        sourcePdfKey: envelope.sourcePdfKey,
        userId,
      }),
    )
    .catch((error) => {
      console.error(
        `Failed to delete the thumbnail for draft envelope ${envelopeId}:`,
        error,
      );
    });

  return envelope;
}
