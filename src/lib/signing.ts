import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

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
import { createRecipientDownloadLink } from "./downloads.ts";
import {
  fieldRecordSchema,
  MAX_DRAWN_SIGNATURE_BYTES,
  signingSubmissionSchema,
  type SigningFieldSubmission,
} from "./schemas/field.ts";
import {
  signingPayloadSchema,
  signingDeclineResponseSchema,
  type SigningDeclineResponse,
  type SigningPayload,
  signingSubmitResponseSchema,
  type SigningSubmitResponse,
  type SigningUnavailableResponse,
} from "./schemas/signing.ts";
import { declineEnvelopeSchema, signerRecordSchema } from "./schemas/signer.ts";
import {
  listAuditEventsForEnvelope,
  recordAuditEvent,
} from "./services/audit.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
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
import { assertServiceConfig } from "./services/service-config.ts";
import { RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS } from "./types/domain.ts";
import { getEnv } from "./utils/env.ts";
import { escapeHtml } from "./utils/html.ts";

const APP_URL_ENV_KEYS = ["APP_URL"] as const;

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
  assertServiceConfig("app", APP_URL_ENV_KEYS, process.env);

  return new URL(`/envelopes/${envelopeId}`, getEnv().appUrl!).toString();
}

const RECIPIENT_DOWNLOAD_LINK_TTL_DAYS =
  RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS / (24 * 60 * 60);

function buildCompletionSenderEmail(input: {
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
    `"${input.envelopeTitle}" has been fully signed in SignuDoc.`,
    "The final signed PDF and certificate are ready in your dashboard.",
    "",
    "Review the completed envelope:",
    completedUrl,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.senderName)},</p>`,
    `<p>&ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; has been fully signed in SignuDoc.</p>`,
    "<p>The final signed PDF and certificate are ready in your dashboard.</p>",
    `<p><a href="${escapeHtml(completedUrl)}">Review the completed envelope</a></p>`,
  ].join("");
  const legalFooter = withUserEmailLegalFooter({
    htmlBody,
    textBody,
  });

  return {
    htmlBody: legalFooter.htmlBody,
    subject,
    template: "completion_notification" as const,
    textBody: legalFooter.textBody,
    to: input.senderEmail,
  };
}

function buildDeclineNotificationEmail(input: {
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
    `${input.signerName} (${input.signerEmail}) declined "${input.envelopeTitle}" in SignuDoc.`,
    ...(reasonLine ? ["", reasonLine] : []),
    "",
    "Review the envelope:",
    envelopeUrl,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.senderName)},</p>`,
    `<p>${escapeHtml(input.signerName)} (${escapeHtml(input.signerEmail)}) declined &ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; in SignuDoc.</p>`,
    reasonLine
      ? `<p><strong>Reason provided:</strong> ${escapeHtml(input.declineReason!.trim())}</p>`
      : "",
    `<p><a href="${escapeHtml(envelopeUrl)}">Review the envelope</a></p>`,
  ].join("");
  const legalFooter = withUserEmailLegalFooter({
    htmlBody,
    textBody,
  });

  return {
    htmlBody: legalFooter.htmlBody,
    subject,
    template: "decline_notification" as const,
    textBody: legalFooter.textBody,
    to: input.senderEmail,
  };
}

function buildCompletionSignerEmail(input: {
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
    `"${input.envelopeTitle}" from ${input.senderName} has been fully signed in SignuDoc.`,
    "The completed document and redacted certificate are ready.",
    "",
    `Download links (available for ${RECIPIENT_DOWNLOAD_LINK_TTL_DAYS} days):`,
    `Signed PDF: ${input.signedDownloadUrl}`,
    `Redacted certificate: ${input.evidenceDownloadUrl}`,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.signerName)},</p>`,
    `<p>&ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; from ${escapeHtml(input.senderName)} has been fully signed in SignuDoc.</p>`,
    "<p>The completed document and redacted certificate are ready.</p>",
    `<p>Download links are available for ${RECIPIENT_DOWNLOAD_LINK_TTL_DAYS} days.</p>`,
    `<p><a href="${escapeHtml(input.signedDownloadUrl)}">Download signed PDF</a><br /><a href="${escapeHtml(input.evidenceDownloadUrl)}">Download redacted certificate</a></p>`,
  ].join("");
  const legalFooter = withUserEmailLegalFooter({
    htmlBody,
    textBody,
  });

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
  envelopeId: string;
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
  database?: DbExecutor;
  emailService: EmailService;
  envelopeId: string;
  envelopeTitle: string;
  sender: SenderRow;
  signers: Array<ReturnType<typeof signerRecordSchema.parse>>;
}) {
  const senderName = normalizeSenderName(input.sender);
  const issuedAt = Math.floor(Date.now() / 1000);
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

      return buildCompletionSignerEmail({
        envelopeId: input.envelopeId,
        envelopeTitle: input.envelopeTitle,
        evidenceDownloadUrl: redactedEvidenceLink.url,
        senderName,
        signedDownloadUrl: signedLink.url,
        signerEmail: signer.email,
        signerName: signer.name,
      });
    }),
  );
  const messages = [
    buildCompletionSenderEmail({
      envelopeId: input.envelopeId,
      envelopeTitle: input.envelopeTitle,
      senderEmail: input.sender.email,
      senderName,
    }),
    ...signerMessages,
  ];

  await input.emailService.sendBatch(messages, {
    idempotencyKey: `completion/${input.envelopeId}`,
  });
}

export class SigningMutationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "SigningMutationError";
    this.statusCode = statusCode;
  }
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
  }: {
    database?: DbPool;
    requestMeta?: SigningRequestMeta;
  } = {},
): Promise<SigningPayload> {
  const context = await resolveSigningContext(token, { database });
  const storageService = createStorageService();

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
    currentSignerFields,
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
  { database = getDb(), requestMeta = {} }: SubmitSigningOptions = {},
): Promise<SigningSubmitResponse> {
  const parsedInput = signingSubmissionSchema.parse(input);
  const context = await resolveSigningContext(token, { database });
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
      envelopeId: context.envelope.id,
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
        await emailService.send(
          buildSigningInvitationEmail({
            envelopeTitle: context.envelope.title,
            senderName: normalizeSenderName(context.sender),
            signerEmail: nextSigner.email,
            signerName: nextSigner.name,
            signingUrl: nextSignerLink.url,
          }),
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
              updated_at = $4
            WHERE id = $5
              AND status = 'sent'
          `,
          [
            finalArtifacts.signedPdf.key,
            finalArtifacts.certificate.key,
            finalArtifacts.generatedAt,
            finalArtifacts.generatedAt,
            context.envelope.id,
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
  { database = getDb(), requestMeta = {} }: SubmitSigningOptions = {},
): Promise<SigningDeclineResponse> {
  const parsedInput = declineEnvelopeSchema.parse(input);
  const context = await resolveSigningContext(token, { database });
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
  let certificate: { key: string };

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
            updated_at = $3
          WHERE id = $4
            AND status = 'sent'
        `,
        [certificate.key, declinedAt, declinedAt, context.envelope.id],
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
    await emailService.send(
      buildDeclineNotificationEmail({
        declineReason,
        envelopeId: context.envelope.id,
        envelopeTitle: context.envelope.title,
        senderEmail: context.sender.email,
        senderName: normalizeSenderName(context.sender),
        signerEmail: context.signer.email,
        signerName: context.signer.name,
      }),
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
  }: {
    database?: DbPool;
  } = {},
) {
  const context = await resolveSigningContext(token, { database });
  const storageService = createStorageService();

  return storageService.getObject(context.envelope.sourcePdfKey);
}
