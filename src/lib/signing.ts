import { Buffer } from "node:buffer";
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
  type AuditEventRecord,
  envelopePageSchema,
  envelopeRecordSchema,
} from "./schemas/envelope.ts";
import {
  createRecipientDownloadLink,
  sanitizeFileNameSegment,
} from "./downloads.ts";
import {
  fieldRecordSchema,
  MAX_DRAWN_SIGNATURE_BYTES,
  signingSubmissionSchema,
  type SigningFieldSubmission,
} from "./schemas/field.ts";
import {
  signerCheckRequestSchema,
  signerConsentRequestSchema,
  signingPayloadSchema,
  signingDeclineResponseSchema,
  type SigningVerificationState,
  type SigningDeclineResponse,
  type SigningPayload,
  signingSubmitResponseSchema,
  type SigningSubmitResponse,
  type SigningUnavailableResponse,
} from "./schemas/signing.ts";
import { declineEnvelopeSchema, signerRecordSchema } from "./schemas/signer.ts";
import { getBranding } from "./settings.ts";
import {
  listAuditEventsForEnvelope,
  recordAuditEvent,
  recordEmailSent,
} from "./services/audit.ts";
import {
  createEmailService,
  fitsAsAttachments,
  type EmailAttachment,
  type EmailService,
} from "./services/email.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import {
  finalizeEnvelope,
  storeEnvelopeCertificatePdf,
  storeRecipientEnvelopeCertificatePdf,
} from "./services/pdf-finalize.ts";
import { buildSigningInvitationEmail } from "./services/signing-invitation-email.ts";
import {
  issueSigningLink,
  type IssuedSigningLink,
} from "./services/signing-links.ts";
import {
  buildEnvelopeCertificateKey,
  buildEnvelopeSignedPdfKey,
  buildSignatureImageKey,
} from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { requireConfigValue } from "./services/service-config.ts";
import { RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS } from "./types/domain.ts";
import { getEnv } from "./utils/env.ts";
import { escapeHtml } from "./utils/html.ts";
import {
  buildElectronicRecordsDisclosure,
  CONSENT_STATEMENT,
  ELECTRONIC_RECORDS_DISCLOSURE_VERSION,
} from "./electronic-records-disclosure.ts";
import {
  checkAccessCode,
  checkEmailCode,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_RESEND_SECONDS,
  EMAIL_CODE_TTL_SECONDS,
  getSignerCheckState,
  issueEmailCode,
  maskEmailAddress,
  requiredSignerChecks,
  type SignerCheckMethod,
  type SignerCheckState,
} from "./signer-checks.ts";

type SigningRequestMeta = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

type FieldPersistenceUpdate = {
  checked: boolean | null;
  fieldId: string;
  imageKey: string | null;
  inputMethod: "auto" | "drawn" | "typed" | null;
  submittedAt: number | null;
  value: string | null;
};

type SigningEnvelopeRow = {
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
  status: "completed" | "declined" | "draft" | "sent" | "voided";
  title: string;
  updatedAt: number;
  userId: string;
  voidedAt: number | null;
};

type SigningSignerRow = {
  createdAt: number;
  declineReason: string | null;
  declinedAt: number | null;
  email: string;
  envelopeId: string;
  id: string;
  lastNotifiedAt: number | null;
  lastNudgedAt: number | null;
  name: string;
  signOrder: number;
  signedAt: number | null;
  signingTokenExpiresAt: number | null;
  signingTokenHash: string | null;
  status: "declined" | "notified" | "pending" | "signed";
  turnStartedAt: number | null;
  updatedAt: number;
};

type SigningFieldRow = {
  checked: boolean | null;
  createdAt: number;
  envelopeId: string;
  height: number;
  id: string;
  imageKey: string | null;
  inputMethod: "auto" | "drawn" | "typed" | null;
  label: string | null;
  page: number;
  required: boolean;
  signerId: string;
  submittedAt: number | null;
  type: "checkbox" | "date" | "initials" | "signature" | "text";
  updatedAt: number;
  value: string | null;
  width: number;
  x: number;
  y: number;
};

type SigningPageRow = {
  envelopeId: string;
  heightPt: number;
  id: string;
  pageNumber: number;
  widthPt: number;
};

type SenderRow = {
  email: string;
  name: string | null;
};

type ResolvedSigningContext = {
  envelope: ReturnType<typeof envelopeRecordSchema.parse>;
  fields: Array<ReturnType<typeof fieldRecordSchema.parse>>;
  pages: Array<ReturnType<typeof envelopePageSchema.parse>>;
  sender: SenderRow;
  signer: ReturnType<typeof signerRecordSchema.parse>;
  signers: Array<ReturnType<typeof signerRecordSchema.parse>>;
};

type SubmitSigningOptions = {
  database?: DbPool;
  requestMeta?: SigningRequestMeta;
  /** The extra checks this browser has passed for the link (from its cookie). */
  verifiedMethods?: readonly SignerCheckMethod[];
};

const signingUnavailableStatusCodeMap: Record<
  SigningUnavailableResponse["state"],
  number
> = {
  "already-signed": 409,
  declined: 409,
  expired: 410,
  voided: 409,
};

export class SigningAccessError extends Error {
  readonly state: SigningUnavailableResponse["state"];
  readonly statusCode: number;

  constructor(
    state: SigningUnavailableResponse["state"],
    message = getSigningUnavailableMessage(state),
  ) {
    super(message);
    this.name = "SigningAccessError";
    this.state = state;
    this.statusCode = signingUnavailableStatusCodeMap[state];
  }
}

function getSigningUnavailableMessage(
  state: SigningUnavailableResponse["state"],
): string {
  switch (state) {
    case "already-signed":
      return "You've already signed.";
    case "declined":
      return "This envelope has been declined.";
    case "voided":
      return "This envelope has been voided.";
    case "expired":
    default:
      return "This link has expired.";
  }
}

function getSigningDocumentUrl(token: string): string {
  return `/api/signing/${encodeURIComponent(token)}/document`;
}

function getSigningSubmitUrl(token: string): string {
  return `/api/signing/${encodeURIComponent(token)}/submit`;
}

function getSigningConsentUrl(token: string): string {
  return `/api/signing/${encodeURIComponent(token)}/consent`;
}

function getSigningDeclineUrl(token: string): string {
  return `/api/signing/${encodeURIComponent(token)}/decline`;
}

function getSigningDoneRedirectPath(
  token: string,
  envelopeTitle: string,
): string {
  const searchParams = new URLSearchParams();

  searchParams.set("title", envelopeTitle);

  return `/sign/${encodeURIComponent(token)}/done?${searchParams.toString()}`;
}

function normalizeSenderName(sender: SenderRow): string {
  return sender.name?.trim() ? sender.name : sender.email;
}

function getEnvelopeUrl(envelopeId: string): string {
  const appUrl = requireConfigValue("app", "APP_URL", getEnv().appUrl);

  return new URL(`/envelopes/${envelopeId}`, appUrl).toString();
}

const RECIPIENT_DOWNLOAD_LINK_TTL_DAYS =
  RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS / (24 * 60 * 60);

function buildCompletionSenderEmail(input: {
  branding: Branding;
  envelopeId: string;
  envelopeTitle: string;
  senderEmail: string;
  senderName: string;
}) {
  const completedUrl = getEnvelopeUrl(input.envelopeId);
  const subject = `"${input.envelopeTitle}" is fully signed`;
  const textBody = [
    `Hi ${input.senderName},`,
    "",
    `"${input.envelopeTitle}" has been fully signed in ${input.branding.productName}.`,
    "The final signed PDF and certificate are ready in your dashboard.",
    "",
    "Review the completed envelope:",
    completedUrl,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.senderName)},</p>`,
    `<p>&ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; has been fully signed in ${escapeHtml(input.branding.productName)}.</p>`,
    "<p>The final signed PDF and certificate are ready in your dashboard.</p>",
    `<p><a href="${escapeHtml(completedUrl)}">Review the completed envelope</a></p>`,
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
    template: "completion_notification" as const,
    textBody: legalFooter.textBody,
    to: input.senderEmail,
  };
}

function buildDeclineNotificationEmail(input: {
  branding: Branding;
  declineReason?: string;
  envelopeId: string;
  envelopeTitle: string;
  senderEmail: string;
  senderName: string;
  signerEmail: string;
  signerName: string;
}) {
  const envelopeUrl = getEnvelopeUrl(input.envelopeId);
  const subject = `"${input.envelopeTitle}" was declined by ${input.signerName}`;
  const reasonLine = input.declineReason?.trim()
    ? `Reason provided: ${input.declineReason.trim()}`
    : null;
  const textBody = [
    `Hi ${input.senderName},`,
    "",
    `${input.signerName} (${input.signerEmail}) declined "${input.envelopeTitle}" in ${input.branding.productName}.`,
    ...(reasonLine ? ["", reasonLine] : []),
    "",
    "Review the envelope:",
    envelopeUrl,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.senderName)},</p>`,
    `<p>${escapeHtml(input.signerName)} (${escapeHtml(input.signerEmail)}) declined &ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; in ${escapeHtml(input.branding.productName)}.</p>`,
    reasonLine
      ? `<p><strong>Reason provided:</strong> ${escapeHtml(input.declineReason!.trim())}</p>`
      : "",
    `<p><a href="${escapeHtml(envelopeUrl)}">Review the envelope</a></p>`,
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
    template: "decline_notification" as const,
    textBody: legalFooter.textBody,
    to: input.senderEmail,
  };
}

function buildCompletionSignerEmail(input: {
  attached: boolean;
  branding: Branding;
  evidenceDownloadUrl: string;
  envelopeId: string;
  envelopeTitle: string;
  senderName: string;
  signerEmail: string;
  signerName: string;
  signedDownloadUrl: string;
}) {
  const subject = `"${input.envelopeTitle}" is fully signed`;
  const textBody = [
    `Hi ${input.signerName},`,
    "",
    `"${input.envelopeTitle}" from ${input.senderName} has been fully signed in ${input.branding.productName}.`,
    input.attached
      ? "The completed document and its certificate are attached. Keep them: they are your copy of the agreement."
      : "The completed document and its certificate are ready.",
    "",
    `Download links (available for ${RECIPIENT_DOWNLOAD_LINK_TTL_DAYS} days; an expired link offers to send a new one):`,
    `Signed PDF: ${input.signedDownloadUrl}`,
    `Redacted certificate: ${input.evidenceDownloadUrl}`,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.signerName)},</p>`,
    `<p>&ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; from ${escapeHtml(input.senderName)} has been fully signed in ${escapeHtml(input.branding.productName)}.</p>`,
    input.attached
      ? "<p>The completed document and its certificate are attached. Keep them: they are your copy of the agreement.</p>"
      : "<p>The completed document and its certificate are ready.</p>",
    `<p>Download links are available for ${RECIPIENT_DOWNLOAD_LINK_TTL_DAYS} days. An expired link offers to send a new one.</p>`,
    `<p><a href="${escapeHtml(input.signedDownloadUrl)}">Download signed PDF</a><br /><a href="${escapeHtml(input.evidenceDownloadUrl)}">Download redacted certificate</a></p>`,
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
    template: "completion_notification" as const,
    textBody: legalFooter.textBody,
    to: input.signerEmail,
  };
}

function mapEnvelopeRow(row: SigningEnvelopeRow) {
  return envelopeRecordSchema.parse(row);
}

function mapSignerRow(row: SigningSignerRow) {
  return signerRecordSchema.parse(row);
}

function mapFieldRow(row: SigningFieldRow) {
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

function mapPageRow(row: SigningPageRow) {
  return envelopePageSchema.parse(row);
}

async function getEnvelopeRow(
  envelopeId: string,
  database: DbExecutor,
): Promise<SigningEnvelopeRow | undefined> {
  return (
    (await queryOne<SigningEnvelopeRow>(
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
          signed_pdf_key AS "signedPdfKey",
          evidence_key AS "evidenceKey",
          source_pdf_hash AS "sourcePdfHash",
          page_count AS "pageCount",
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
    )) ?? undefined
  );
}

async function listSignerRows(
  envelopeId: string,
  database: DbExecutor,
): Promise<SigningSignerRow[]> {
  return queryMany<SigningSignerRow>(
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
}

async function getSignerRowBySigningTokenHash(
  tokenHash: string,
  database: DbExecutor,
): Promise<SigningSignerRow | null> {
  return queryOne<SigningSignerRow>(
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
      WHERE signing_token_hash = $1
      LIMIT 1
    `,
    [tokenHash],
  );
}

async function listFieldRows(
  envelopeId: string,
  database: DbExecutor,
): Promise<SigningFieldRow[]> {
  return queryMany<SigningFieldRow>(
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
}

async function listPageRows(
  envelopeId: string,
  database: DbExecutor,
): Promise<SigningPageRow[]> {
  return queryMany<SigningPageRow>(
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
}

async function getSenderRow(
  userId: string,
  database: DbExecutor,
): Promise<SenderRow | undefined> {
  return (
    (await queryOne<SenderRow>(
      database,
      `
        SELECT
          name,
          email
        FROM "user"
        WHERE id = $1
      `,
      [userId],
    )) ?? undefined
  );
}

async function recordViewedEventOnce(
  context: Pick<ResolvedSigningContext, "envelope" | "signer">,
  meta: SigningRequestMeta,
  database: DbPool,
): Promise<void> {
  await withTransaction(async (tx) => {
    const existing = await queryOne<{ id: string }>(
      tx,
      `
        SELECT id
        FROM audit_events
        WHERE envelope_id = $1
          AND event = 'viewed'
          AND metadata->>'signerId' = $2
        LIMIT 1
      `,
      [context.envelope.id, context.signer.id],
    );

    if (existing) {
      return;
    }

    await recordAuditEvent(
      {
        actorEmail: context.signer.email,
        actorType: "signer",
        envelopeId: context.envelope.id,
        event: "viewed",
        ipAddress: meta.ipAddress ?? null,
        metadata: {
          signerEmail: context.signer.email,
          signerId: context.signer.id,
          signerName: context.signer.name,
          signerOrder: context.signer.signOrder,
        },
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
  }, database);
}

async function buildImageDataUrl(
  imageKey: string,
  storageService: StorageService,
): Promise<string> {
  const imageObject = await storageService.getObject(imageKey);

  return `data:${imageObject.contentType ?? "image/png"};base64,${Buffer.from(imageObject.body).toString("base64")}`;
}

function formatLocalSigningDate(
  submittedAt: number,
  timezoneOffsetMinutes: number,
): string {
  const localDateTime = new Date(
    submittedAt * 1000 - timezoneOffsetMinutes * 60 * 1000,
  );

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(localDateTime);
}

function parsePngDataUrl(dataUrl: string): Uint8Array {
  const match = dataUrl
    .trim()
    .match(/^data:image\/png;base64,([a-z0-9+/=\s]+)$/i);

  if (!match?.[1]) {
    throw new SigningMutationError(
      "Drawn signatures must be submitted as PNG images.",
      400,
    );
  }

  const base64Body = match[1].replace(/\s+/g, "");
  const paddingLength = base64Body.endsWith("==")
    ? 2
    : base64Body.endsWith("=")
      ? 1
      : 0;
  const decodedByteLength =
    Math.floor((base64Body.length * 3) / 4) - paddingLength;

  if (decodedByteLength > MAX_DRAWN_SIGNATURE_BYTES) {
    throw new SigningMutationError(
      "Drawn signature image data is too large.",
      400,
    );
  }

  const imageBody = Buffer.from(base64Body, "base64");

  if (imageBody.byteLength === 0) {
    throw new SigningMutationError("Drawn signature image data is empty.", 400);
  }

  if (imageBody.byteLength > MAX_DRAWN_SIGNATURE_BYTES) {
    throw new SigningMutationError(
      "Drawn signature image data is too large.",
      400,
    );
  }

  return new Uint8Array(imageBody);
}

function isFieldSubmissionComplete(
  field: ReturnType<typeof fieldRecordSchema.parse>,
  update: FieldPersistenceUpdate,
): boolean {
  if (!field.required) {
    return true;
  }

  switch (field.type) {
    case "signature":
    case "initials":
    case "date":
      return typeof update.submittedAt === "number";
    case "text":
      return typeof update.value === "string" && update.value.trim().length > 0;
    case "checkbox":
      return update.checked === true;
    default:
      return false;
  }
}

function buildSignedAuditEvent(input: {
  authMethods: readonly SignerCheckMethod[];
  envelopeId: string;
  signatureMethods: readonly string[];
  requestMeta: SigningRequestMeta;
  signer: ReturnType<typeof signerRecordSchema.parse>;
  submittedAt: number;
  timezoneOffsetMinutes: number;
}): AuditEventRecord {
  return {
    actorEmail: input.signer.email,
    actorType: "signer",
    createdAt: input.submittedAt,
    envelopeId: input.envelopeId,
    event: "signed",
    id: randomUUID(),
    ipAddress: input.requestMeta.ipAddress ?? null,
    metadata: {
      signerEmail: input.signer.email,
      signerId: input.signer.id,
      signerName: input.signer.name,
      signerOrder: input.signer.signOrder,
      authMethods: [...input.authMethods],
      signatureMethods: [...input.signatureMethods],
      timezoneOffsetMinutes: input.timezoneOffsetMinutes,
    },
    userAgent: input.requestMeta.userAgent ?? null,
  };
}

function buildDeclinedAuditEvent(input: {
  declinedAt: number;
  envelopeId: string;
  reason?: string;
  requestMeta: SigningRequestMeta;
  signer: ReturnType<typeof signerRecordSchema.parse>;
}): AuditEventRecord {
  return {
    actorEmail: input.signer.email,
    actorType: "signer",
    createdAt: input.declinedAt,
    envelopeId: input.envelopeId,
    event: "declined",
    id: randomUUID(),
    ipAddress: input.requestMeta.ipAddress ?? null,
    metadata: {
      ...(input.reason ? { reason: input.reason } : {}),
      signerEmail: input.signer.email,
      signerId: input.signer.id,
      signerName: input.signer.name,
      signerOrder: input.signer.signOrder,
    },
    userAgent: input.requestMeta.userAgent ?? null,
  };
}

function applyFieldUpdatesToRecords(
  fields: Array<ReturnType<typeof fieldRecordSchema.parse>>,
  fieldUpdates: Map<string, FieldPersistenceUpdate>,
  updatedAt: number,
) {
  return fields.map((field) => {
    if (!field.id) {
      return field;
    }

    const update = fieldUpdates.get(field.id);

    if (!update) {
      return field;
    }

    return fieldRecordSchema.parse({
      ...field,
      checked: update.checked,
      imageKey: update.imageKey,
      inputMethod: update.inputMethod,
      submittedAt: update.submittedAt,
      updatedAt,
      value: update.value,
    });
  });
}

function applyCurrentSignerCompletion(
  signers: Array<ReturnType<typeof signerRecordSchema.parse>>,
  currentSignerId: string,
  submittedAt: number,
) {
  return signers.map((signer) => {
    if (signer.id !== currentSignerId) {
      return signer;
    }

    return signerRecordSchema.parse({
      ...signer,
      signedAt: submittedAt,
      signingTokenExpiresAt: null,
      signingTokenHash: null,
      status: "signed",
      updatedAt: submittedAt,
    });
  });
}

function applyCurrentSignerDecline(
  signers: Array<ReturnType<typeof signerRecordSchema.parse>>,
  currentSignerId: string,
  declinedAt: number,
  reason?: string,
) {
  return signers.map((signer) => {
    if (signer.id !== currentSignerId) {
      return signer;
    }

    return signerRecordSchema.parse({
      ...signer,
      declineReason: reason ?? null,
      declinedAt,
      signingTokenExpiresAt: null,
      signingTokenHash: null,
      status: "declined",
      updatedAt: declinedAt,
    });
  });
}

async function sendCompletionEmails(input: {
  attachments: {
    recipientCertificate: Uint8Array;
    signedPdf: Uint8Array;
  };
  database?: DbExecutor;
  emailService: EmailService;
  envelopeId: string;
  envelopeTitle: string;
  sender: SenderRow;
  signers: Array<ReturnType<typeof signerRecordSchema.parse>>;
}) {
  const fileNameStem =
    sanitizeFileNameSegment(input.envelopeTitle) ||
    `envelope-${input.envelopeId}`;
  const attachments: EmailAttachment[] = [
    {
      content: input.attachments.signedPdf,
      contentType: "application/pdf",
      filename: `${fileNameStem} - signed.pdf`,
    },
    {
      content: input.attachments.recipientCertificate,
      contentType: "application/pdf",
      filename: `${fileNameStem} - certificate.pdf`,
    },
  ];
  const attach = fitsAsAttachments(attachments);
  const senderName = normalizeSenderName(input.sender);
  const issuedAt = Math.floor(Date.now() / 1000);
  const branding = await getBranding();
  const signerMessages = await Promise.all(
    input.signers.map(async (signer) => {
      if (!signer.id) {
        throw new SigningMutationError(
          "Completed signer records must include an id.",
          500,
        );
      }

      const [signedLink, redactedEvidenceLink] = await Promise.all([
        createRecipientDownloadLink(
          {
            envelopeId: input.envelopeId,
            fileType: "signed",
            issuedAt,
            signerId: signer.id,
          },
          {
            database: input.database,
          },
        ),
        // Recipient certificate downloads resolve to the redacted certificate PDF.
        createRecipientDownloadLink(
          {
            envelopeId: input.envelopeId,
            fileType: "evidence",
            issuedAt,
            signerId: signer.id,
          },
          {
            database: input.database,
          },
        ),
      ]);

      return {
        message: {
          ...buildCompletionSignerEmail({
            attached: attach,
            branding,
            envelopeId: input.envelopeId,
            envelopeTitle: input.envelopeTitle,
            evidenceDownloadUrl: redactedEvidenceLink.url,
            senderName,
            signedDownloadUrl: signedLink.url,
            signerEmail: signer.email,
            signerName: signer.name,
          }),
          ...(attach ? { attachments } : {}),
        },
        signerId: signer.id,
      };
    }),
  );
  const messages = [
    {
      message: buildCompletionSenderEmail({
        branding,
        envelopeId: input.envelopeId,
        envelopeTitle: input.envelopeTitle,
        senderEmail: input.sender.email,
        senderName,
      }),
      signerId: null,
    },
    ...signerMessages,
  ];

  // One by one: Resend's batch endpoint does not take attachments. Each
  // message is tried even if another fails, so one bad address does not cost
  // everyone else their copy.
  const failures: unknown[] = [];

  for (const [index, { message, signerId }] of messages.entries()) {
    try {
      const delivery = await input.emailService.send(message, {
        idempotencyKey: `completion/${input.envelopeId}/${String(index)}`,
      });

      await recordEmailSent(
        {
          envelopeId: input.envelopeId,
          messageId: delivery.messageId,
          recipient: message.to,
          signerId,
          template: "completion_notification",
        },
        input.database,
      );
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Some completion emails were not sent.");
  }
}

export class SigningMutationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "SigningMutationError";
    this.statusCode = statusCode;
  }
}

/** The signer must pass the sender's extra checks before going further. */
export class SigningVerificationRequiredError extends Error {
  readonly details: SigningVerificationState;
  readonly statusCode = 401;

  constructor(details: SigningVerificationState) {
    super("Confirm your identity to open this document.");
    this.name = "SigningVerificationRequiredError";
    this.details = details;
  }
}

async function assertSignerChecksPassed(
  context: ResolvedSigningContext,
  verifiedMethods: readonly SignerCheckMethod[],
  database: DbExecutor,
): Promise<{ passed: SignerCheckMethod[]; state: SignerCheckState }> {
  const state = await getSignerCheckState(context.signer.id!, database);
  const required = requiredSignerChecks(state);
  const pending = required.filter(
    (method) => !verifiedMethods.includes(method),
  );

  if (pending.length > 0) {
    throw new SigningVerificationRequiredError({
      emailCodeSentAt: state.emailCodeSentAt,
      envelopeTitle: context.envelope.title,
      maskedEmail: maskEmailAddress(context.signer.email),
      pending,
      required,
      senderName: normalizeSenderName(context.sender),
    });
  }

  return { passed: required, state };
}

function signerAuditMetadata(context: ResolvedSigningContext) {
  return {
    signerEmail: context.signer.email,
    signerId: context.signer.id,
    signerName: context.signer.name,
    signerOrder: context.signer.signOrder,
  };
}

/** Emails the signer a one-time code, when the sender asked for one. */
export async function sendSignerEmailCode(
  token: string,
  {
    database = getDb(),
    emailService = createEmailService(),
  }: { database?: DbPool; emailService?: EmailService } = {},
): Promise<{ emailCodeSentAt: number; maskedEmail: string }> {
  const context = await resolveSigningContext(token, { database });
  const state = await getSignerCheckState(context.signer.id!, database);
  const now = Math.floor(Date.now() / 1000);

  if (!state.requireEmailCode) {
    throw new SigningMutationError("No code is needed for this link.", 400);
  }

  if (
    state.emailCodeSentAt !== null &&
    now - state.emailCodeSentAt < EMAIL_CODE_RESEND_SECONDS &&
    state.emailCodeHash
  ) {
    return {
      emailCodeSentAt: state.emailCodeSentAt,
      maskedEmail: maskEmailAddress(context.signer.email),
    };
  }

  const issued = issueEmailCode();
  const branding = await getBranding();

  await database.query(
    `
      UPDATE signers
      SET
        email_code_hash = $1,
        email_code_expires_at = $2,
        email_code_attempts = 0,
        email_code_sent_at = $3
      WHERE id = $4
    `,
    [issued.hash, now + EMAIL_CODE_TTL_SECONDS, now, context.signer.id],
  );

  const minutes = Math.round(EMAIL_CODE_TTL_SECONDS / 60);
  const textBody = [
    `Hi ${context.signer.name},`,
    "",
    `Your code to open "${context.envelope.title}" in ${branding.productName} is:`,
    "",
    issued.code,
    "",
    `It works for ${String(minutes)} minutes. If you did not just open a signing link, ignore this email.`,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(context.signer.name)},</p>`,
    `<p>Your code to open &ldquo;${escapeHtml(context.envelope.title)}&rdquo; in ${escapeHtml(branding.productName)} is:</p>`,
    `<p style="font-size:24px;font-weight:700;letter-spacing:4px">${issued.code}</p>`,
    `<p>It works for ${String(minutes)} minutes. If you did not just open a signing link, ignore this email.</p>`,
  ].join("");
  const body = withUserEmailLegalFooter({ htmlBody, textBody }, branding);
  const delivery = await emailService.send({
    htmlBody: body.htmlBody,
    subject: `Your code for "${context.envelope.title}"`,
    template: "signing_code",
    textBody: body.textBody,
    to: context.signer.email,
  });

  await recordEmailSent(
    {
      envelopeId: context.envelope.id,
      messageId: delivery.messageId,
      recipient: context.signer.email,
      signerId: context.signer.id,
      template: "signing_code",
    },
    database,
  );

  return {
    emailCodeSentAt: now,
    maskedEmail: maskEmailAddress(context.signer.email),
  };
}

/**
 * Checks an access code or emailed code. Returns every check this browser
 * has now passed, for the caller to store in the link's cookie.
 */
export async function verifySignerCheck(
  token: string,
  input: unknown,
  {
    database = getDb(),
    requestMeta = {},
    verifiedMethods = [],
  }: SubmitSigningOptions = {},
): Promise<SignerCheckMethod[]> {
  const parsed = signerCheckRequestSchema.parse(input);
  const context = await resolveSigningContext(token, { database });
  const state = await getSignerCheckState(context.signer.id!, database);
  const now = Math.floor(Date.now() / 1000);
  let passed = false;

  if (!requiredSignerChecks(state).includes(parsed.method)) {
    throw new SigningMutationError("This check is not needed.", 400);
  }

  if (parsed.method === "access_code") {
    passed = checkAccessCode(parsed.code, state.accessCodeHash!);
  } else {
    if (
      !state.emailCodeHash ||
      state.emailCodeExpiresAt === null ||
      state.emailCodeExpiresAt < now
    ) {
      throw new SigningMutationError(
        "That code has expired. Send a new one.",
        410,
      );
    }

    passed = checkEmailCode(parsed.code, state.emailCodeHash);

    const attempts = state.emailCodeAttempts + 1;

    await database.query(
      passed || attempts >= EMAIL_CODE_MAX_ATTEMPTS
        ? `UPDATE signers SET email_code_hash = NULL, email_code_expires_at = NULL, email_code_attempts = $1 WHERE id = $2`
        : `UPDATE signers SET email_code_attempts = $1 WHERE id = $2`,
      [attempts, context.signer.id],
    );
  }

  await recordAuditEvent(
    {
      actorEmail: context.signer.email,
      actorType: "signer",
      envelopeId: context.envelope.id,
      event: passed ? "verified" : "verification_failed",
      ipAddress: requestMeta.ipAddress ?? null,
      metadata: { ...signerAuditMetadata(context), method: parsed.method },
      userAgent: requestMeta.userAgent ?? null,
    },
    database,
  );

  if (!passed) {
    throw new SigningMutationError("That code is not right.", 400);
  }

  return [...new Set([...verifiedMethods, parsed.method])];
}

/** Records that the signer agreed to use electronic records and signatures. */
export async function recordSignerConsent(
  token: string,
  input: unknown,
  {
    database = getDb(),
    requestMeta = {},
    verifiedMethods = [],
  }: SubmitSigningOptions = {},
): Promise<{ consentedAt: number }> {
  const parsed = signerConsentRequestSchema.parse(input);
  const context = await resolveSigningContext(token, { database });
  const { state } = await assertSignerChecksPassed(
    context,
    verifiedMethods,
    database,
  );

  if (parsed.disclosureVersion !== ELECTRONIC_RECORDS_DISCLOSURE_VERSION) {
    throw new SigningMutationError(
      "The disclosure has changed. Reload the page to read the current one.",
      409,
    );
  }

  if (state.consentedAt !== null) {
    return { consentedAt: state.consentedAt };
  }

  const consentedAt = Math.floor(Date.now() / 1000);

  await withTransaction(async (tx) => {
    const updated = await tx.query(
      `
        UPDATE signers
        SET consented_at = $1
        WHERE id = $2 AND consented_at IS NULL
      `,
      [consentedAt, context.signer.id],
    );

    if (updated.rowCount !== 1) {
      return;
    }

    await recordAuditEvent(
      {
        actorEmail: context.signer.email,
        actorType: "signer",
        createdAt: consentedAt,
        envelopeId: context.envelope.id,
        event: "consented",
        ipAddress: requestMeta.ipAddress ?? null,
        metadata: {
          ...signerAuditMetadata(context),
          disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION,
          statement: CONSENT_STATEMENT,
        },
        userAgent: requestMeta.userAgent ?? null,
      },
      tx,
    );
  }, database);

  return { consentedAt };
}

async function resolveSigningContext(
  token: string,
  {
    database = getDb(),
  }: {
    database?: DbExecutor;
  } = {},
): Promise<ResolvedSigningContext> {
  const signerRow = await getSignerRowBySigningTokenHash(
    hashOpaqueToken(token),
    database,
  );

  if (!signerRow) {
    throw new SigningAccessError("expired");
  }

  const envelopeRow = await getEnvelopeRow(signerRow.envelopeId, database);

  if (!envelopeRow) {
    throw new SigningAccessError("expired");
  }

  if (envelopeRow.status === "voided") {
    throw new SigningAccessError("voided");
  }

  if (envelopeRow.status === "declined") {
    throw new SigningAccessError("declined");
  }

  const signers = (await listSignerRows(envelopeRow.id, database)).map(
    mapSignerRow,
  );
  const signer = signers.find((entry) => entry.id === signerRow.id);

  if (!signer) {
    throw new SigningAccessError("expired");
  }

  if (signer.status === "signed") {
    throw new SigningAccessError("already-signed");
  }

  if (typeof signer.signOrder !== "number") {
    throw new SigningAccessError("expired");
  }

  const now = Math.floor(Date.now() / 1000);
  const signingTokenExpiresAt = signer.signingTokenExpiresAt ?? null;

  if (
    envelopeRow.status !== "sent" ||
    signer.status !== "notified" ||
    signer.envelopeId !== envelopeRow.id ||
    signer.signingTokenHash !== signerRow.signingTokenHash ||
    (signingTokenExpiresAt !== null && signingTokenExpiresAt < now)
  ) {
    throw new SigningAccessError("expired");
  }

  const sender = await getSenderRow(envelopeRow.userId, database);

  if (!sender) {
    throw new SigningAccessError("expired");
  }

  return {
    envelope: mapEnvelopeRow(envelopeRow),
    fields: (await listFieldRows(envelopeRow.id, database)).map(mapFieldRow),
    pages: (await listPageRows(envelopeRow.id, database)).map(mapPageRow),
    sender,
    signer,
    signers,
  };
}

export async function getSigningPayloadForToken(
  token: string,
  {
    database = getDb(),
    requestMeta = {},
    verifiedMethods = [],
  }: {
    database?: DbPool;
    requestMeta?: SigningRequestMeta;
    verifiedMethods?: readonly SignerCheckMethod[];
  } = {},
): Promise<SigningPayload> {
  const context = await resolveSigningContext(token, { database });
  const { state: checkState } = await assertSignerChecksPassed(
    context,
    verifiedMethods,
    database,
  );
  const storageService = createStorageService();
  const branding = await getBranding();

  await recordViewedEventOnce(context, requestMeta, database);

  const signerNamesById = new Map(
    context.signers.map((signer) => [signer.id, signer.name] as const),
  );
  const signerOrdersById = new Map(
    context.signers.map((signer) => [signer.id, signer.signOrder] as const),
  );
  const currentSignerOrder = context.signer.signOrder ?? 0;

  const currentSignerFields = context.fields
    .filter((field) => field.signerId === context.signer.id)
    .map((field) => ({
      height: field.height,
      id: field.id,
      label: field.label,
      page: field.page,
      required: field.required,
      signerId: field.signerId,
      signerName: context.signer.name,
      type: field.type,
      width: field.width,
      x: field.x,
      y: field.y,
    }));

  const visibleFields = await Promise.all(
    context.fields
      .filter((field) => {
        const signerOrder = signerOrdersById.get(field.signerId);

        return (
          typeof signerOrder === "number" &&
          signerOrder < currentSignerOrder &&
          typeof field.submittedAt === "number"
        );
      })
      .map(async (field) => ({
        checked: field.checked ?? null,
        height: field.height,
        id: field.id,
        imageDataUrl: field.imageKey
          ? await buildImageDataUrl(field.imageKey, storageService)
          : null,
        inputMethod: field.inputMethod ?? null,
        label: field.label,
        page: field.page,
        required: field.required,
        signerId: field.signerId,
        signerName: signerNamesById.get(field.signerId) ?? "Signed field",
        submittedAt: field.submittedAt!,
        type: field.type,
        value: field.value ?? null,
        width: field.width,
        x: field.x,
        y: field.y,
      })),
  );

  return signingPayloadSchema.parse({
    consentUrl: getSigningConsentUrl(token),
    consentedAt: checkState.consentedAt,
    currentSignerFields,
    disclosure: {
      sections: buildElectronicRecordsDisclosure({
        contactAddress: branding.supportAddress ?? context.sender.email,
        senderName: normalizeSenderName(context.sender),
      }),
      statement: CONSENT_STATEMENT,
      version: ELECTRONIC_RECORDS_DISCLOSURE_VERSION,
    },
    declineUrl: getSigningDeclineUrl(token),
    documentUrl: getSigningDocumentUrl(token),
    envelopeId: context.envelope.id,
    envelopeTitle: context.envelope.title,
    pageCount: context.envelope.pageCount,
    pages: context.pages,
    senderName: normalizeSenderName(context.sender),
    signer: {
      email: context.signer.email,
      id: context.signer.id,
      name: context.signer.name,
      order: context.signer.signOrder,
    },
    state: "ready",
    submitUrl: getSigningSubmitUrl(token),
    visibleFields,
  });
}

export async function submitSigningForToken(
  token: string,
  input: unknown,
  {
    database = getDb(),
    requestMeta = {},
    verifiedMethods = [],
  }: SubmitSigningOptions = {},
): Promise<SigningSubmitResponse> {
  const parsedInput = signingSubmissionSchema.parse(input);
  const context = await resolveSigningContext(token, { database });
  const signerChecks = await assertSignerChecksPassed(
    context,
    verifiedMethods,
    database,
  );

  if (signerChecks.state.consentedAt === null) {
    throw new SigningMutationError(
      "Agree to use electronic records and signatures before signing.",
      409,
    );
  }

  const emailService = createEmailService();
  const storageService = createStorageService();
  const currentSignerId = context.signer.id;

  if (!currentSignerId) {
    throw new SigningMutationError(
      "This signing link is no longer active.",
      409,
    );
  }

  const currentSignerFields = context.fields.filter(
    (
      field,
    ): field is ReturnType<typeof fieldRecordSchema.parse> & { id: string } =>
      field.signerId === currentSignerId && typeof field.id === "string",
  );

  if (currentSignerFields.length === 0) {
    throw new SigningMutationError(
      "No signable fields are assigned to this signer.",
      400,
    );
  }

  const currentSignerFieldsById = new Map(
    currentSignerFields.map((field) => [field.id, field] as const),
  );
  const relevantSubmissions = new Map<string, SigningFieldSubmission>();

  for (const submission of parsedInput.fields) {
    const matchingField = currentSignerFieldsById.get(submission.fieldId);

    if (!matchingField || matchingField.type !== submission.type) {
      continue;
    }

    if (relevantSubmissions.has(submission.fieldId)) {
      throw new SigningMutationError(
        "Each field can only be submitted once.",
        400,
      );
    }

    relevantSubmissions.set(submission.fieldId, submission);
  }

  const submittedAt = Math.floor(Date.now() / 1000);
  const localDateValue = formatLocalSigningDate(
    submittedAt,
    parsedInput.clientTimezoneOffsetMinutes,
  );
  const drawnSignatureUploads: Array<{
    body: Uint8Array;
    imageKey: string;
  }> = [];
  const fieldUpdates = new Map<string, FieldPersistenceUpdate>();

  for (const field of currentSignerFields) {
    const submission = relevantSubmissions.get(field.id);

    if (field.type === "signature" || field.type === "initials") {
      if (!submission) {
        fieldUpdates.set(field.id, {
          checked: null,
          fieldId: field.id,
          imageKey: null,
          inputMethod: null,
          submittedAt: null,
          value: null,
        });
        continue;
      }

      if (submission.type !== field.type) {
        continue;
      }

      if (submission.inputMethod === "typed") {
        fieldUpdates.set(field.id, {
          checked: null,
          fieldId: field.id,
          imageKey: null,
          inputMethod: "typed",
          submittedAt,
          value: submission.value,
        });
        continue;
      }

      const imageKey = buildSignatureImageKey({
        envelopeId: context.envelope.id,
        fieldId: field.id,
        userId: context.envelope.userId,
      });

      drawnSignatureUploads.push({
        body: parsePngDataUrl(submission.imageDataUrl),
        imageKey,
      });
      fieldUpdates.set(field.id, {
        checked: null,
        fieldId: field.id,
        imageKey,
        inputMethod: "drawn",
        submittedAt,
        value: null,
      });
      continue;
    }

    if (field.type === "date") {
      fieldUpdates.set(field.id, {
        checked: null,
        fieldId: field.id,
        imageKey: null,
        inputMethod: "auto",
        submittedAt,
        value: localDateValue,
      });
      continue;
    }

    if (field.type === "text") {
      const trimmedValue =
        submission?.type === "text" ? submission.value.trim() : null;

      fieldUpdates.set(field.id, {
        checked: null,
        fieldId: field.id,
        imageKey: null,
        inputMethod: null,
        submittedAt: trimmedValue ? submittedAt : null,
        value: trimmedValue,
      });
      continue;
    }

    const checkedValue =
      submission?.type === "checkbox" ? submission.checked : false;

    fieldUpdates.set(field.id, {
      checked: checkedValue,
      fieldId: field.id,
      imageKey: null,
      inputMethod: null,
      submittedAt,
      value: null,
    });
  }

  const missingRequiredField = currentSignerFields.find((field) => {
    const update = fieldUpdates.get(field.id);

    return !update || !isFieldSubmissionComplete(field, update);
  });

  if (missingRequiredField) {
    throw new SigningMutationError(
      "Complete all required fields before finishing.",
      400,
    );
  }

  let signingStatePersisted = false;

  try {
    const currentSignerIndex = context.signers.findIndex(
      (signer) => signer.id === context.signer.id,
    );
    const nextSigner =
      currentSignerIndex >= 0
        ? context.signers[currentSignerIndex + 1]
        : undefined;
    let nextSignerLink: IssuedSigningLink | undefined;

    if (nextSigner) {
      if (nextSigner.status !== "pending") {
        throw new SigningMutationError(
          "Envelope routing is out of sync for the next signer.",
          409,
        );
      }

      if (!nextSigner.id) {
        throw new SigningMutationError(
          "Envelope routing is out of sync for the next signer.",
          500,
        );
      }

      nextSignerLink = await issueSigningLink({
        issuedAt: submittedAt,
      });
    }

    for (const upload of drawnSignatureUploads) {
      await storageService.putObject({
        body: upload.body,
        contentType: "image/png",
        key: upload.imageKey,
      });
    }

    const signedAuditEvent = buildSignedAuditEvent({
      authMethods: signerChecks.passed,
      envelopeId: context.envelope.id,
      signatureMethods: [
        ...new Set(
          [...fieldUpdates.values()]
            .filter((update) =>
              currentSignerFields.some(
                (field) =>
                  field.id === update.fieldId &&
                  (field.type === "signature" || field.type === "initials"),
              ),
            )
            .map((update) => update.inputMethod)
            .filter(
              (method): method is "typed" | "drawn" =>
                method === "typed" || method === "drawn",
            ),
        ),
      ],
      requestMeta,
      signer: context.signer,
      submittedAt,
      timezoneOffsetMinutes: parsedInput.clientTimezoneOffsetMinutes,
    });

    if (nextSigner && nextSignerLink) {
      await withTransaction(async (tx) => {
        await tx.query(
          `
            UPDATE envelopes
            SET updated_at = $1
            WHERE id = $2
              AND status = 'sent'
          `,
          [submittedAt, context.envelope.id],
        );

        for (const update of fieldUpdates.values()) {
          const result = await tx.query(
            `
              UPDATE fields
              SET
                input_method = $1,
                value = $2,
                image_key = $3,
                checked = $4,
                submitted_at = $5,
                updated_at = $6
              WHERE id = $7
                AND envelope_id = $8
                AND signer_id = $9
            `,
            [
              update.inputMethod,
              update.value,
              update.imageKey,
              update.checked,
              update.submittedAt,
              submittedAt,
              update.fieldId,
              context.envelope.id,
              currentSignerId,
            ],
          );

          if (result.rowCount !== 1) {
            throw new SigningMutationError(
              "Unable to save one or more field values.",
              500,
            );
          }
        }

        const signedSignerResult = await tx.query(
          `
            UPDATE signers
            SET
              status = 'signed',
              signing_token_hash = NULL,
              signing_token_expires_at = NULL,
              signed_at = $1,
              updated_at = $2
            WHERE id = $3
              AND envelope_id = $4
              AND status = 'notified'
          `,
          [submittedAt, submittedAt, currentSignerId, context.envelope.id],
        );

        if (signedSignerResult.rowCount !== 1) {
          throw new SigningMutationError(
            "This signing link is no longer active.",
            409,
          );
        }

        const nextSignerResult = await tx.query(
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
              AND status = 'pending'
          `,
          [
            nextSignerLink.tokenHash,
            nextSignerLink.exp,
            submittedAt,
            submittedAt,
            submittedAt,
            nextSigner.id,
            context.envelope.id,
          ],
        );

        if (nextSignerResult.rowCount !== 1) {
          throw new SigningMutationError(
            "Unable to activate the next signer for this envelope.",
            500,
          );
        }

        await recordAuditEvent(
          {
            actorEmail: signedAuditEvent.actorEmail,
            actorType: signedAuditEvent.actorType,
            id: signedAuditEvent.id,
            createdAt: signedAuditEvent.createdAt,
            envelopeId: signedAuditEvent.envelopeId,
            event: signedAuditEvent.event,
            ipAddress: signedAuditEvent.ipAddress,
            metadata: signedAuditEvent.metadata,
            userAgent: signedAuditEvent.userAgent,
          },
          tx,
        );
      }, database);
      signingStatePersisted = true;

      try {
        const delivery = await emailService.send(
          buildSigningInvitationEmail({
            branding: await getBranding(),
            envelopeTitle: context.envelope.title,
            senderName: normalizeSenderName(context.sender),
            signerEmail: nextSigner.email,
            signerName: nextSigner.name,
            signingUrl: nextSignerLink.url,
          }),
        );

        await recordEmailSent(
          {
            envelopeId: context.envelope.id,
            messageId: delivery.messageId,
            recipient: nextSigner.email,
            signerId: nextSigner.id,
            template: "signing_invitation",
          },
          database,
        );
      } catch (error) {
        console.error(
          `Failed to send next signer invitation for envelope ${context.envelope.id} to ${nextSigner.email}:`,
          error,
        );
      }

      return signingSubmitResponseSchema.parse({
        envelopeId: context.envelope.id,
        redirectPath: getSigningDoneRedirectPath(token, context.envelope.title),
        submittedAt,
      });
    }

    const completedFields = applyFieldUpdatesToRecords(
      context.fields,
      fieldUpdates,
      submittedAt,
    );
    const completedSigners = applyCurrentSignerCompletion(
      context.signers,
      currentSignerId,
      submittedAt,
    );
    const sourcePdfHead = await storageService.headObject(
      context.envelope.sourcePdfKey,
    );

    if (!sourcePdfHead.exists) {
      throw new SigningMutationError(
        "The source document for this envelope could not be found.",
        500,
      );
    }

    const finalArtifacts = await finalizeEnvelope(
      {
        auditEvents: [
          ...(await listAuditEventsForEnvelope(context.envelope.id, database)),
          signedAuditEvent,
        ],
        envelope: context.envelope,
        fields: completedFields,
        signers: completedSigners,
        sourcePdf: {
          bucketName: sourcePdfHead.bucketName,
          key: context.envelope.sourcePdfKey,
        },
      },
      {
        storageService,
      },
    );
    const storageIdentity = {
      envelopeId: context.envelope.id,
      userId: context.envelope.userId,
    };
    const storedArtifactKeys = [
      buildEnvelopeSignedPdfKey(storageIdentity),
      buildEnvelopeCertificateKey({
        ...storageIdentity,
        audience: "internal",
      }),
      buildEnvelopeCertificateKey({
        ...storageIdentity,
        audience: "recipient",
      }),
    ];

    try {
      await withTransaction(async (tx) => {
        for (const update of fieldUpdates.values()) {
          const result = await tx.query(
            `
              UPDATE fields
              SET
                input_method = $1,
                value = $2,
                image_key = $3,
                checked = $4,
                submitted_at = $5,
                updated_at = $6
              WHERE id = $7
                AND envelope_id = $8
                AND signer_id = $9
            `,
            [
              update.inputMethod,
              update.value,
              update.imageKey,
              update.checked,
              update.submittedAt,
              submittedAt,
              update.fieldId,
              context.envelope.id,
              currentSignerId,
            ],
          );

          if (result.rowCount !== 1) {
            throw new SigningMutationError(
              "Unable to save one or more field values.",
              500,
            );
          }
        }

        const signedSignerResult = await tx.query(
          `
            UPDATE signers
            SET
              status = 'signed',
              signing_token_hash = NULL,
              signing_token_expires_at = NULL,
              signed_at = $1,
              updated_at = $2
            WHERE id = $3
              AND envelope_id = $4
              AND status = 'notified'
          `,
          [submittedAt, submittedAt, currentSignerId, context.envelope.id],
        );

        if (signedSignerResult.rowCount !== 1) {
          throw new SigningMutationError(
            "This signing link is no longer active.",
            409,
          );
        }

        const completedEnvelopeResult = await tx.query(
          `
            UPDATE envelopes
            SET
              status = 'completed',
              signed_pdf_key = $1,
              evidence_key = $2,
              completed_at = $3,
              updated_at = $4,
              signed_pdf_sha256 = $6,
              evidence_sha256 = $7,
              recipient_evidence_sha256 = $8
            WHERE id = $5
              AND status = 'sent'
          `,
          [
            finalArtifacts.signedPdf.key,
            finalArtifacts.certificate.key,
            finalArtifacts.generatedAt,
            finalArtifacts.generatedAt,
            context.envelope.id,
            finalArtifacts.signedPdf.sha256,
            finalArtifacts.certificate.sha256,
            finalArtifacts.recipientCertificate.sha256,
          ],
        );

        if (completedEnvelopeResult.rowCount !== 1) {
          throw new SigningMutationError(
            "Unable to finalize this completed envelope.",
            500,
          );
        }

        await recordAuditEvent(
          {
            actorEmail: signedAuditEvent.actorEmail,
            actorType: signedAuditEvent.actorType,
            id: signedAuditEvent.id,
            createdAt: signedAuditEvent.createdAt,
            envelopeId: signedAuditEvent.envelopeId,
            event: signedAuditEvent.event,
            ipAddress: signedAuditEvent.ipAddress,
            metadata: signedAuditEvent.metadata,
            userAgent: signedAuditEvent.userAgent,
          },
          tx,
        );

        await recordAuditEvent(
          {
            actorEmail: null,
            actorType: "system",
            createdAt: finalArtifacts.generatedAt,
            envelopeId: context.envelope.id,
            event: "completed",
            metadata: null,
          },
          tx,
        );
      }, database);
      signingStatePersisted = true;
    } catch (error) {
      await Promise.all(
        storedArtifactKeys.map((key) =>
          storageService.deleteObject(key).catch(() => undefined),
        ),
      );
      throw error;
    }

    try {
      await sendCompletionEmails({
        attachments: {
          recipientCertificate: finalArtifacts.recipientCertificate.body,
          signedPdf: finalArtifacts.signedPdf.body,
        },
        database,
        emailService,
        envelopeId: context.envelope.id,
        envelopeTitle: context.envelope.title,
        sender: context.sender,
        signers: completedSigners,
      });
    } catch (error) {
      console.error(
        `Failed to send completion emails for envelope ${context.envelope.id}:`,
        error,
      );
    }

    return signingSubmitResponseSchema.parse({
      envelopeId: context.envelope.id,
      redirectPath: getSigningDoneRedirectPath(token, context.envelope.title),
      submittedAt,
    });
  } catch (error) {
    if (!signingStatePersisted) {
      await Promise.all(
        drawnSignatureUploads.map((upload) =>
          storageService.deleteObject(upload.imageKey).catch(() => undefined),
        ),
      );
    }

    throw error;
  }
}

export async function declineSigningForToken(
  token: string,
  input: unknown,
  {
    database = getDb(),
    requestMeta = {},
    verifiedMethods = [],
  }: SubmitSigningOptions = {},
): Promise<SigningDeclineResponse> {
  const parsedInput = declineEnvelopeSchema.parse(input);
  const context = await resolveSigningContext(token, { database });

  await assertSignerChecksPassed(context, verifiedMethods, database);
  const emailService = createEmailService();
  const storageService = createStorageService();
  const currentSignerId = context.signer.id;

  if (!currentSignerId) {
    throw new SigningMutationError(
      "This signing link is no longer active.",
      409,
    );
  }

  const declinedAt = Math.floor(Date.now() / 1000);
  const declineReason = parsedInput.reason?.trim() || undefined;
  const sourcePdfHead = await storageService.headObject(
    context.envelope.sourcePdfKey,
  );

  if (!sourcePdfHead.exists) {
    throw new SigningMutationError(
      "The source document for this envelope could not be found.",
      500,
    );
  }

  const declinedAuditEvent = buildDeclinedAuditEvent({
    declinedAt,
    envelopeId: context.envelope.id,
    reason: declineReason,
    requestMeta,
    signer: context.signer,
  });
  const storageIdentity = {
    envelopeId: context.envelope.id,
    userId: context.envelope.userId,
  };
  const canonicalCertificate = {
    bucketName: sourcePdfHead.bucketName,
    key: buildEnvelopeCertificateKey({
      ...storageIdentity,
      audience: "internal",
    }),
  };
  const declinedEnvelope = envelopeRecordSchema.parse({
    ...context.envelope,
    declinedAt,
    evidenceKey: canonicalCertificate.key,
    status: "declined",
    updatedAt: declinedAt,
  });
  const declinedSigners = applyCurrentSignerDecline(
    context.signers,
    currentSignerId,
    declinedAt,
    declineReason,
  );
  const auditEvents = [
    ...(await listAuditEventsForEnvelope(context.envelope.id, database)),
    declinedAuditEvent,
  ];
  const storedCertificateKeys: string[] = [];
  let certificate: { key: string; sha256: string };
  let recipientCertificateSha256: string;

  try {
    certificate = await storeEnvelopeCertificatePdf(
      {
        auditEvents,
        certificate: canonicalCertificate,
        envelope: declinedEnvelope,
        signers: declinedSigners,
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
        envelope: declinedEnvelope,
        signers: declinedSigners,
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
      const declinedSignerResult = await tx.query(
        `
          UPDATE signers
          SET
            status = 'declined',
            signing_token_hash = NULL,
            signing_token_expires_at = NULL,
            declined_at = $1,
            decline_reason = $2,
            updated_at = $3
          WHERE id = $4
            AND envelope_id = $5
            AND status = 'notified'
        `,
        [
          declinedAt,
          declineReason ?? null,
          declinedAt,
          currentSignerId,
          context.envelope.id,
        ],
      );

      if (declinedSignerResult.rowCount !== 1) {
        throw new SigningMutationError(
          "This signing link is no longer active.",
          409,
        );
      }

      const declinedEnvelopeResult = await tx.query(
        `
          UPDATE envelopes
          SET
            status = 'declined',
            evidence_key = $1,
            declined_at = $2,
            updated_at = $3,
            evidence_sha256 = $5,
            recipient_evidence_sha256 = $6
          WHERE id = $4
            AND status = 'sent'
        `,
        [
          certificate.key,
          declinedAt,
          declinedAt,
          context.envelope.id,
          certificate.sha256,
          recipientCertificateSha256,
        ],
      );

      if (declinedEnvelopeResult.rowCount !== 1) {
        throw new SigningMutationError(
          "This signing link is no longer active.",
          409,
        );
      }

      await recordAuditEvent(
        {
          actorEmail: declinedAuditEvent.actorEmail,
          actorType: declinedAuditEvent.actorType,
          id: declinedAuditEvent.id,
          createdAt: declinedAuditEvent.createdAt,
          envelopeId: declinedAuditEvent.envelopeId,
          event: declinedAuditEvent.event,
          ipAddress: declinedAuditEvent.ipAddress,
          metadata: declinedAuditEvent.metadata,
          userAgent: declinedAuditEvent.userAgent,
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

  try {
    const delivery = await emailService.send(
      buildDeclineNotificationEmail({
        branding: await getBranding(),
        declineReason,
        envelopeId: context.envelope.id,
        envelopeTitle: context.envelope.title,
        senderEmail: context.sender.email,
        senderName: normalizeSenderName(context.sender),
        signerEmail: context.signer.email,
        signerName: context.signer.name,
      }),
    );

    await recordEmailSent(
      {
        envelopeId: context.envelope.id,
        messageId: delivery.messageId,
        recipient: context.sender.email,
        template: "decline_notification",
      },
      database,
    );
  } catch (error) {
    console.error(
      `Failed to send decline notification for envelope ${context.envelope.id}:`,
      error,
    );
  }

  return signingDeclineResponseSchema.parse({
    declinedAt,
    envelopeId: context.envelope.id,
    state: "declined",
  });
}

export async function getSigningDocumentForToken(
  token: string,
  {
    database = getDb(),
    verifiedMethods = [],
  }: {
    database?: DbPool;
    verifiedMethods?: readonly SignerCheckMethod[];
  } = {},
) {
  const context = await resolveSigningContext(token, { database });

  await assertSignerChecksPassed(context, verifiedMethods, database);
  const storageService = createStorageService();

  return storageService.getObject(context.envelope.sourcePdfKey);
}
