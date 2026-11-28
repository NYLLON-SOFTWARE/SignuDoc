import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { waitUntil } from "@vercel/functions";

import { type Branding } from "./branding.ts";
import { readInvitationCopy } from "./invitation-copy.ts";
import { removeUnclaimedEnvelopeCertificates } from "./certificate-cleanup.ts";
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
  type SigningSubmission,
} from "./schemas/field.ts";
import {
  approvalSubmissionSchema,
  signerCheckRequestSchema,
  signerConsentRequestSchema,
  signingFieldFitRequestSchema,
  signingPayloadSchema,
  signingDeclineResponseSchema,
  type SigningVerificationState,
  type SigningDeclineResponse,
  type SigningPayload,
  signingSubmitResponseSchema,
  type SigningSubmitResponse,
  type SigningUnavailableResponse,
} from "./schemas/signing.ts";
import {
  declineEnvelopeSchema,
  signerRecordSchema,
  type CopyRecipientRecord,
} from "./schemas/signer.ts";
import {
  getBranding,
  readStoredSettings,
  resolveSettings,
} from "./settings.ts";
import {
  checkSigningCredentials,
  MAX_SIGNING_PASSWORD_ATTEMPTS,
  type PasswordVerifier,
  SIGNATURE_MEANING_DETAILS,
} from "./part11.ts";
import {
  listAuditEventsForEnvelope,
  lockEnvelopeAuditChain,
  recordAuditEvent,
  recordEmailSent,
} from "./services/audit.ts";
import {
  createEmailService,
  createLazyEmailService,
  fitsAsAttachments,
  type EmailAttachment,
  type EmailService,
} from "./services/email.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import {
  sendEnvelopeNotices,
  sendSigningInvitation,
} from "./services/envelope-notice-email.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import {
  finalizeEnvelope,
  findTypedValueTooLongForField,
  loadInstallSealer,
  storeEnvelopeCertificatePdf,
  storeRecipientEnvelopeCertificatePdf,
} from "./services/pdf-finalize.ts";
import { buildSigningInvitationEmail } from "./services/signing-invitation-email.ts";
import { isEmbeddedEnvelope, readEmbedEvidence } from "./embedding.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import { signingProviderById } from "./services/signing-providers.ts";
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
import {
  RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS,
  type FieldType,
} from "./types/domain.ts";
import { getEnv } from "./utils/env.ts";
import { escapeHtml } from "./utils/html.ts";
import {
  isEnvelopeExpired,
  nextSignerLinkExpiresAt,
} from "./envelope-deadline.ts";
import { describeEntryProblem, judgeRadioGroups } from "./field-choices.ts";
import { consumeRateLimit, refundRateLimit } from "./security/rate-limit.ts";
import {
  buildDisclosureSections,
  CONSENT_STATEMENT,
  disclosureSectionsAsText,
  getDisclosureVersion,
  normalizeCustomDisclosure,
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
import {
  isEarlierStep,
  routeAfterSignatures,
  signingStepOf,
} from "./signing-steps.ts";

export type SigningRequestMeta = {
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
  expiresAt: number | null;
  id: string;
  pageCount: number;
  part11: boolean;
  revisionKey: string | null;
  revisionSha256: string | null;
  sentAt: number | null;
  signatureLevel: "advanced" | "qualified" | "simple";
  signatureProvider: string | null;
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
  role: "approver" | "signer";
  signOrder: number;
  signingStep: number | null;
  signatureMeaning:
    "approval" | "authorship" | "responsibility" | "review" | null;
  signedAt: number | null;
  signingTokenExpiresAt: number | null;
  signingTokenHash: string | null;
  status: "declined" | "notified" | "pending" | "signed";
  userId: string | null;
  turnStartedAt: number | null;
  updatedAt: number;
};

type SigningFieldRow = {
  checked: boolean | null;
  createdAt: number;
  envelopeId: string;
  groupId: string | null;
  height: number;
  id: string;
  imageKey: string | null;
  inputMethod: "auto" | "drawn" | "typed" | null;
  label: string | null;
  options: string[] | null;
  page: number;
  required: boolean;
  signerId: string;
  submittedAt: number | null;
  type: FieldType;
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

/** What a signer's own certificate showed, kept in the audit trail. */
export type ProviderSignatureEvidence = {
  certificateIssuer: string;
  certificateSerialNumber: string;
  certificateSubject: string;
  /** Unix seconds. */
  certificateValidTo: number;
  level: "advanced" | "qualified";
  /** How the signer identified themselves at the provider, when it says. */
  method: string | null;
  provider: string;
  /** The certificate says it is qualified, on a qualified device. */
  qualified: boolean;
  timestamped: boolean;
};

/**
 * A signature a signing provider made for the signer, in a revision of the
 * PDF of its own. See provider-signing.ts.
 */
export type ProviderSignatureCompletion = {
  /** The revision this one was added to, as it was when the signer began. */
  baseSha256: string | null;
  evidence: ProviderSignatureEvidence;
  revision: { bytes: Uint8Array; key: string; sha256: string };
  sessionId: string;
  /** When the signer submitted, which the revision's dates are from. */
  submittedAt: number;
};

type SubmitSigningOptions = {
  database?: DbPool;
  emailService?: EmailService;
  /** Set when a signing provider signed: see provider-signing.ts. */
  providerSignature?: ProviderSignatureCompletion;
  requestMeta?: SigningRequestMeta;
  storageService?: StorageService;
  /** The extra checks this browser has passed for the link (from its cookie). */
  verifiedMethods?: readonly SignerCheckMethod[];
  /** Replaced in tests: checks a Part 11 signer's password. */
  verifyPassword?: PasswordVerifier;
};

const signingUnavailableStatusCodeMap: Record<
  SigningUnavailableResponse["state"],
  number
> = {
  "already-signed": 409,
  completed: 409,
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

/** An approver reviews and approves or rejects; they sign nothing. */
function isApprover(signer: { role?: string | null }): boolean {
  return signer.role === "approver";
}

function getSigningUnavailableMessage(
  state: SigningUnavailableResponse["state"],
): string {
  switch (state) {
    case "already-signed":
      return "You've already signed.";
    case "completed":
      return "This envelope has been completed.";
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

function getSigningApproveUrl(token: string): string {
  return `/api/signing/${encodeURIComponent(token)}/approve`;
}

function getSigningFieldFitUrl(token: string): string {
  return `/api/signing/${encodeURIComponent(token)}/fit`;
}

function getSigningDeclineUrl(token: string): string {
  return `/api/signing/${encodeURIComponent(token)}/decline`;
}

function getSigningDoneRedirectPath(
  token: string,
  envelopeTitle: string,
  approved = false,
): string {
  const searchParams = new URLSearchParams();

  searchParams.set("title", envelopeTitle);

  if (approved) {
    searchParams.set("approved", "1");
  }

  return `/sign/${encodeURIComponent(token)}/done?${searchParams.toString()}`;
}

function normalizeSenderName(sender: SenderRow): string {
  return sender.name?.trim() ? sender.name : sender.email;
}

function getEnvelopeUrl(envelopeId: string): string {
  const appUrl = requireConfigValue("app", "APP_URL", getEnv().appUrl);

  return new URL(`/envelopes/${envelopeId}`, appUrl).toString();
}

function getVerifiedEnvelopeSender(
  envelopeId: string,
  userId: string,
  database: DbExecutor,
) {
  return queryOne<SenderRow>(
    database,
    `SELECT u.name, u.email
     FROM envelopes e JOIN "user" u ON u.id = e.user_id
     WHERE e.id = $1 AND e.user_id = $2 AND u."emailVerified"
       AND NOT EXISTS (
         SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
       )`,
    [envelopeId, userId],
  );
}

async function notifySenderOfActivity(
  event: "viewed" | "signed" | "approved",
  eventId: string,
  context: ResolvedSigningContext,
  database: DbPool,
  emailService?: EmailService,
): Promise<void> {
  const sendSender = process.env.SIGNUDOC_EMAIL_SENDER_ACTIVITY === "1";
  const sendCopies = process.env.SIGNUDOC_EMAIL_COPY_ACTIVITY === "1";
  if (!sendSender && !sendCopies) return;

  const { envelope, signer } = context;
  const mailer = emailService ?? createLazyEmailService();
  const verb = event === "viewed" ? "opened" : event;
  const subject = `${signer.name} ${verb} "${envelope.title}"`.replace(
    /\s+/g,
    " ",
  );
  const senderDelivery = (async () => {
    if (!sendSender) return;
    const sender = await getVerifiedEnvelopeSender(
      envelope.id,
      envelope.userId,
      database,
    );
    if (!sender || sender.email.toLowerCase() === signer.email.toLowerCase()) {
      return;
    }

    const template = `sender_signer_${event}` as const;
    const url = getEnvelopeUrl(envelope.id);
    const name = sender.name?.trim().split(/\s+/, 1)[0] || "there";
    const content = withUserEmailLegalFooter(
      {
        textBody: `Hi ${name},\n\n${subject}.\n\nReview the envelope:\n${url}`,
        htmlBody: `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(subject)}.</p><p><a href="${escapeHtml(url)}">Review the envelope</a></p>`,
      },
      await getBranding(),
    );
    const delivery = await mailer.send(
      { ...content, subject, template, to: sender.email },
      { idempotencyKey: `sender-activity/${eventId}` },
    );
    await recordEmailSent(
      {
        envelopeId: envelope.id,
        messageId: delivery.messageId,
        recipient: sender.email,
        signerId: signer.id,
        template,
      },
      database,
    );
  })().catch((error: unknown) => {
    console.error(
      `Failed to send sender activity email for envelope ${envelope.id}:`,
      error,
    );
  });
  const copyDelivery = (async () => {
    if (!sendCopies || (await isEmbeddedEnvelope(envelope.id, database)))
      return;
    const source = await listCopyRecipientRows(envelope.id, database);
    const excluded = new Set([
      signer.email.toLowerCase(),
      context.sender.email.toLowerCase(),
    ]);
    await sendEnvelopeNotices({
      database,
      emailService: mailer,
      envelope,
      eventKey: eventId,
      message: `${subject}.`,
      recipients: source.filter(
        (recipient) => !excluded.has(recipient.email.toLowerCase()),
      ),
      template: "copy_recipient_activity",
    });
  })().catch((error: unknown) => {
    console.error(
      `Failed to list copy recipients for envelope ${envelope.id}:`,
      error,
    );
  });
  const delivery = Promise.all([senderDelivery, copyDelivery]);
  if (process.env.VERCEL === "1") {
    waitUntil(delivery);
  } else {
    // Cloud Run can suspend request-based CPU after the response.
    await delivery;
  }
}

const RECIPIENT_DOWNLOAD_LINK_TTL_DAYS =
  RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS / (24 * 60 * 60);

function buildCompletionSenderEmail(input: {
  attachments?: EmailAttachment[];
  branding: Branding;
  envelopeId: string;
  envelopeTitle: string;
  senderEmail: string;
  senderName: string;
}) {
  const completedUrl = getEnvelopeUrl(input.envelopeId);
  const subject = `"${input.envelopeTitle}" is fully signed`;
  const documentAvailability = input.attachments
    ? "The final signed PDF is attached. The certificate is available in your dashboard."
    : "The final signed PDF and certificate are ready in your dashboard.";
  const textBody = [
    `Hi ${input.senderName},`,
    "",
    `"${input.envelopeTitle}" has been fully signed in ${input.branding.productName}.`,
    documentAvailability,
    "",
    "Review the completed envelope:",
    completedUrl,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.senderName)},</p>`,
    `<p>&ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; has been fully signed in ${escapeHtml(input.branding.productName)}.</p>`,
    `<p>${documentAvailability}</p>`,
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
    ...(input.attachments ? { attachments: input.attachments } : {}),
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
  /** An approver rejected it, rather than a signer declining. */
  rejected?: boolean;
  senderEmail: string;
  senderName: string;
  signerEmail: string;
  signerName: string;
}) {
  const envelopeUrl = getEnvelopeUrl(input.envelopeId);
  const verb = input.rejected ? "rejected" : "declined";
  const subject = `"${input.envelopeTitle}" was ${verb} by ${input.signerName}`;
  const reasonLine = input.declineReason?.trim()
    ? `Reason provided: ${input.declineReason.trim()}`
    : null;
  const textBody = [
    `Hi ${input.senderName},`,
    "",
    `${input.signerName} (${input.signerEmail}) ${verb} "${input.envelopeTitle}" in ${input.branding.productName}.`,
    ...(reasonLine ? ["", reasonLine] : []),
    "",
    "Review the envelope:",
    envelopeUrl,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.senderName)},</p>`,
    `<p>${escapeHtml(input.signerName)} (${escapeHtml(input.signerEmail)}) ${verb} &ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; in ${escapeHtml(input.branding.productName)}.</p>`,
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
  /** True for someone who gets a copy without having signed. */
  copyOnly?: boolean;
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
    ...(input.copyOnly
      ? [`${input.senderName} asked for you to receive a copy.`]
      : []),
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
    input.copyOnly
      ? `<p>${escapeHtml(input.senderName)} asked for you to receive a copy.</p>`
      : "",
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
    groupId: row.groupId ?? undefined,
    height: row.height,
    id: row.id,
    imageKey: row.imageKey,
    inputMethod: row.inputMethod,
    label: row.label ?? undefined,
    options: row.options ?? undefined,
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
          part11,
          signature_level AS "signatureLevel",
          signature_provider AS "signatureProvider",
          revision_key AS "revisionKey",
          revision_sha256 AS "revisionSha256",
          sent_at AS "sentAt",
          completed_at AS "completedAt",
          declined_at AS "declinedAt",
          voided_at AS "voidedAt",
          expires_at AS "expiresAt",
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
        role,
        sign_order AS "signOrder",
        signing_step AS "signingStep",
        status,
        signing_token_hash AS "signingTokenHash",
        signing_token_expires_at AS "signingTokenExpiresAt",
        turn_started_at AS "turnStartedAt",
        last_notified_at AS "lastNotifiedAt",
        last_nudged_at AS "lastNudgedAt",
        signed_at AS "signedAt",
        declined_at AS "declinedAt",
        decline_reason AS "declineReason",
        signature_meaning AS "signatureMeaning",
        user_id AS "userId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM signers
      WHERE envelope_id = $1
        -- Copy recipients are not part of the signing order. Approvers
        -- are, and move it on exactly as signers do.
        AND role IN ('signer', 'approver')
      ORDER BY sign_order ASC, id ASC
    `,
    [envelopeId],
  );
}

/** The people who get the finished document without signing it. */
async function listCopyRecipientRows(
  envelopeId: string,
  database: DbExecutor,
): Promise<CopyRecipientRecord[]> {
  return queryMany<CopyRecipientRecord>(
    database,
    `
      SELECT id, name, email
      FROM signers
      WHERE envelope_id = $1
        AND role = 'cc'
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
        signing_step AS "signingStep",
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
        options,
        group_id AS "groupId",
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

/**
 * Takes hold of an envelope that is out for signature before a signer's
 * rows are changed, and refuses when it no longer is. A new deadline, a
 * void, a reminder and the deletion of the sender's account all take the
 * envelope's row first and its signers after. The last signature and a
 * decline used to take the signer first and the envelope last, so one of
 * them and one of those could wait for each other until Postgres
 * cancelled one.
 *
 * The lock an UPDATE takes, not FOR UPDATE: the audit event stored in the
 * same transaction needs a share of this row for its foreign key.
 */
async function lockSentEnvelope(
  envelopeId: string,
  tx: DbExecutor,
): Promise<void> {
  const locked = await tx.query(
    `
      SELECT id FROM envelopes
      WHERE id = $1 AND status = 'sent'
      FOR NO KEY UPDATE
    `,
    [envelopeId],
  );

  if (locked.rowCount !== 1) {
    // Voided, declined or deleted since the page was opened.
    throw new SigningMutationError(
      "This signing link is no longer active.",
      409,
    );
  }
}

/**
 * Confirms this request still holds the waiting signer's current link
 * before any of their rows are written. The token is read once when the
 * page is opened; a correction can replace the hash in the meantime and
 * leave status as notified, which the later UPDATE used to treat as enough.
 * The link must also not have expired since: removing an embedding site
 * expires its links, and a submission already under way must not finish
 * on one.
 */
async function lockSignerForPresentedToken(
  tx: DbExecutor,
  {
    envelopeId,
    signerId,
    tokenHash,
  }: {
    envelopeId: string;
    signerId: string;
    tokenHash: string;
  },
): Promise<void> {
  const locked = await queryOne<{ expiresAt: number | null }>(
    tx,
    `
      SELECT signing_token_expires_at AS "expiresAt"
      FROM signers
      WHERE id = $1
        AND envelope_id = $2
        AND status = 'notified'
        AND signing_token_hash = $3
      FOR NO KEY UPDATE
    `,
    [signerId, envelopeId, tokenHash],
  );

  // The expiry is checked once the lock is held, on the row as it is then
  // and against the time then. A time taken before the query would be as
  // old as the wait for the lock, and could let through a link that
  // expired during it, such as one whose site was removed meanwhile.
  if (
    !locked ||
    (locked.expiresAt !== null &&
      locked.expiresAt < Math.floor(Date.now() / 1000))
  ) {
    throw new SigningMutationError(
      "This signing link is no longer active.",
      409,
    );
  }
}

async function recordViewedEventOnce(
  context: Pick<ResolvedSigningContext, "envelope" | "signer">,
  meta: SigningRequestMeta,
  database: DbPool,
): Promise<string | undefined> {
  return withTransaction(async (tx) => {
    // Two first openings at once must not both pass the check below and
    // record two first views (and send two signer.viewed webhooks). This
    // lock is taken only here, before any other, so it cannot deadlock.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `signudoc:first-view:${context.signer.id ?? ""}`,
    ]);

    const existing = await queryOne<{ id: string }>(
      tx,
      `
        SELECT id
        FROM audit_events
        WHERE envelope_id = $1
          AND event = 'viewed'
          AND metadata->>'signerId' = $2
          -- A corrected signer keeps the row id, so the first view by the
          -- person now at that address is recorded too.
          AND lower(metadata->>'signerEmail') = lower($3)
        LIMIT 1
      `,
      [context.envelope.id, context.signer.id, context.signer.email],
    );

    if (existing) {
      return;
    }

    const viewed = await recordAuditEvent(
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
    return viewed.id;
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
    case "name":
      return typeof update.submittedAt === "number";
    case "text":
    case "number":
    case "dropdown":
      return typeof update.value === "string" && update.value.trim().length > 0;
    case "checkbox":
      return update.checked === true;
    case "radio":
      // One button is never the whole answer: the group is judged together,
      // once every button's value is known.
      return true;
    default:
      return false;
  }
}

/**
 * Checks the radio buttons group by group: never more than one chosen, and
 * exactly one where the group is required.
 */
function assertRadioGroupsAnswered(
  fields: ReadonlyArray<ReturnType<typeof fieldRecordSchema.parse>>,
  updates: ReadonlyMap<string, FieldPersistenceUpdate>,
) {
  const verdict = judgeRadioGroups(
    fields,
    (field) =>
      field.id !== undefined && updates.get(field.id)?.checked === true,
  );

  if (verdict === "too_many") {
    throw new SigningMutationError(
      "Choose only one option in each group of radio buttons.",
      400,
    );
  }

  if (verdict === "missing") {
    throw new SigningMutationError(
      "Complete all required fields before finishing.",
      400,
    );
  }
}

type Part11SignatureRecord = {
  /** How the signer gave both parts of their signature again. */
  credential: "account_password";
  meaning: NonNullable<SigningSignerRow["signatureMeaning"]>;
  meaningStatement: string;
  reauthenticatedAt: number;
  userId: string;
};

function buildSignedAuditEvent(input: {
  authMethods: readonly SignerCheckMethod[];
  embedded?: { apiKeyName: string | null; origin: string | null } | null;
  envelopeId: string;
  part11?: Part11SignatureRecord | null;
  providerSignature?: ProviderSignatureEvidence | null;
  signatureMethods: readonly string[];
  requestMeta: SigningRequestMeta;
  signer: ReturnType<typeof signerRecordSchema.parse>;
  submittedAt: number;
  timezoneOffsetMinutes: number;
}): AuditEventRecord {
  // An approver's decision is its own event, never "signed": the audit
  // trail and the certificate must not show an approval as a signature.
  const approval = isApprover(input.signer);

  return {
    actorEmail: input.signer.email,
    actorType: "signer",
    createdAt: input.submittedAt,
    envelopeId: input.envelopeId,
    event: approval ? "approved" : "signed",
    id: randomUUID(),
    ipAddress: input.requestMeta.ipAddress ?? null,
    metadata: {
      signerEmail: input.signer.email,
      signerId: input.signer.id,
      signerName: input.signer.name,
      signerOrder: input.signer.signOrder,
      signingStep: signingStepOf(input.signer),
      ...(approval ? { role: "approver" } : {}),
      authMethods: [...input.authMethods],
      signatureMethods: [...input.signatureMethods],
      timezoneOffsetMinutes: input.timezoneOffsetMinutes,
      ...(input.embedded ? { embedded: input.embedded } : {}),
      ...(input.part11 ? { part11: input.part11 } : {}),
      ...(input.providerSignature
        ? { providerSignature: input.providerSignature }
        : {}),
    },
    userAgent: input.requestMeta.userAgent ?? null,
  };
}

function buildDeclinedAuditEvent(input: {
  /** The checks the person passed before declining or rejecting. */
  authMethods: readonly string[];
  declinedAt: number;
  embedded?: { apiKeyName: string | null; origin: string | null } | null;
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
    // An approver rejects; the envelope ends the same way as a decline.
    event: isApprover(input.signer) ? "rejected" : "declined",
    id: randomUUID(),
    ipAddress: input.requestMeta.ipAddress ?? null,
    metadata: {
      ...(input.reason ? { reason: input.reason } : {}),
      signerEmail: input.signer.email,
      signerId: input.signer.id,
      signerName: input.signer.name,
      signerOrder: input.signer.signOrder,
      signingStep: signingStepOf(input.signer),
      ...(input.embedded ? { embedded: input.embedded } : {}),
      ...(isApprover(input.signer) ? { role: "approver" } : {}),
      authMethods: [...input.authMethods],
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
  copyRecipients: readonly CopyRecipientRecord[];
  database: DbExecutor;
  emailService: EmailService;
  envelopeId: string;
  envelopeTitle: string;
  sender: SenderRow;
  senderUserId: string;
  signers: Array<ReturnType<typeof signerRecordSchema.parse>>;
}) {
  const fileNameStem =
    sanitizeFileNameSegment(input.envelopeTitle) ||
    `envelope-${input.envelopeId}`;
  const signedAttachment: EmailAttachment = {
    content: input.attachments.signedPdf,
    contentType: "application/pdf",
    filename: `${fileNameStem} - signed.pdf`,
  };
  const recipientCertificateAttachment: EmailAttachment = {
    content: input.attachments.recipientCertificate,
    contentType: "application/pdf",
    filename: `${fileNameStem} - certificate.pdf`,
  };
  const attachments = [signedAttachment, recipientCertificateAttachment];
  const senderAttachments = [signedAttachment];
  const attach = fitsAsAttachments(attachments);
  const verifiedSender =
    process.env.SIGNUDOC_EMAIL_SENDER_COMPLETION_ATTACHMENTS === "1" &&
    fitsAsAttachments(senderAttachments)
      ? await getVerifiedEnvelopeSender(
          input.envelopeId,
          input.senderUserId,
          input.database,
        ).catch((error: unknown) => {
          console.error(
            `Failed to verify sender for completion attachment on envelope ${input.envelopeId}:`,
            error,
          );
          return null;
        })
      : null;
  const senderName = normalizeSenderName(input.sender);
  const issuedAt = Math.floor(Date.now() / 1000);
  const branding = await getBranding();
  // Signers first, then the people who only get a copy: the place in this
  // list is part of each message's idempotency key.
  const recipients = [
    ...input.signers.map((signer) => ({ ...signer, copyOnly: false })),
    ...input.copyRecipients.map((recipient) => ({
      ...recipient,
      copyOnly: true,
    })),
  ];
  const signerMessages = await Promise.all(
    recipients.map(async (signer) => {
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
            copyOnly: signer.copyOnly,
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
        attachments:
          verifiedSender?.email === input.sender.email
            ? senderAttachments
            : undefined,
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

/** Wrong access codes a signer may give for one code in a week. */
export const ACCESS_CODE_MAX_FAILURES = 10;
const ACCESS_CODE_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

export type SignerEmailCodeResult = {
  emailCodeSentAt: number;
  maskedEmail: string;
  /** Seconds until a new code can be sent; 0 when this call sent one. */
  retryAfterSeconds: number;
  /**
   * Whether this call emailed a new code. False during the resend cooldown,
   * when the code sent a moment ago is still the one to use.
   */
  sent: boolean;
};

function cooldownResult(
  emailCodeSentAt: number,
  now: number,
  maskedEmail: string,
): SignerEmailCodeResult {
  return {
    emailCodeSentAt,
    maskedEmail,
    retryAfterSeconds: Math.max(
      1,
      emailCodeSentAt + EMAIL_CODE_RESEND_SECONDS - now,
    ),
    sent: false,
  };
}

/** Emails the signer a one-time code, when the sender asked for one. */
export async function sendSignerEmailCode(
  token: string,
  {
    database = getDb(),
    emailService = createEmailService(),
  }: { database?: DbPool; emailService?: EmailService } = {},
): Promise<SignerEmailCodeResult> {
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
    return cooldownResult(
      state.emailCodeSentAt,
      now,
      maskEmailAddress(context.signer.email),
    );
  }

  const issued = issueEmailCode();
  const branding = await getBranding();
  // Claim the resend window and save the code in one statement, so two
  // tabs cannot both send, leaving one emailed code already replaced.
  const presentedTokenHash = hashOpaqueToken(token);
  const claimed = await database.query(
    `
      UPDATE signers
      SET
        email_code_hash = $1,
        email_code_expires_at = $2,
        email_code_attempts = 0,
        email_code_sent_at = $3
      WHERE id = $4
        AND signing_token_hash = $6
        AND (
          email_code_hash IS NULL
          OR email_code_sent_at IS NULL
          OR email_code_sent_at <= $5
        )
    `,
    [
      issued.hash,
      now + EMAIL_CODE_TTL_SECONDS,
      now,
      context.signer.id,
      now - EMAIL_CODE_RESEND_SECONDS,
      presentedTokenHash,
    ],
  );

  if (claimed.rowCount !== 1) {
    const stillThisLink = await queryOne<{ id: string }>(
      database,
      `
        SELECT id
        FROM signers
        WHERE id = $1 AND signing_token_hash = $2
      `,
      [context.signer.id, presentedTokenHash],
    );

    if (!stillThisLink) {
      throw new SigningMutationError(
        "This signing link is no longer active.",
        409,
      );
    }

    // Another request claimed the window first. Its code is the one to use,
    // unless that send failed and cleared it again in the meantime.
    const current = await getSignerCheckState(context.signer.id!, database);

    if (current.emailCodeHash === null || current.emailCodeSentAt === null) {
      throw new SigningMutationError(
        "The code could not be sent right now. Try again.",
        503,
      );
    }

    return cooldownResult(
      current.emailCodeSentAt,
      now,
      maskEmailAddress(context.signer.email),
    );
  }

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
  let delivery: Awaited<ReturnType<EmailService["send"]>>;

  try {
    delivery = await emailService.send({
      htmlBody: body.htmlBody,
      subject: `Your code for "${context.envelope.title}"`,
      template: "signing_code",
      textBody: body.textBody,
      to: context.signer.email,
    });
  } catch (error) {
    // Not sent, so the signer may ask again at once.
    await database.query(
      `
        UPDATE signers
        SET
          email_code_hash = NULL,
          email_code_expires_at = NULL,
          email_code_sent_at = NULL,
          email_code_attempts = 0
        WHERE id = $1 AND email_code_hash = $2
      `,
      [context.signer.id, issued.hash],
    );
    throw error;
  }

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
    retryAfterSeconds: 0,
    sent: true,
  };
}

/**
 * Checks an access code or emailed code. Returns every check this browser
 * has now passed, for the caller to store in the link's cookie.
 */
function describeCredentialFailure(result: {
  attemptsLeft: number;
  identityNotConfirmed?: true;
  locked: boolean;
}): string {
  if (result.identityNotConfirmed) {
    return "Your account cannot sign this document right now: an administrator has to confirm your identity, and your email address must be confirmed. Ask the sender or an administrator.";
  }

  if (result.locked) {
    return `This account is locked for signing after ${MAX_SIGNING_PASSWORD_ATTEMPTS} wrong passwords. Ask an administrator to unlock it.`;
  }

  return `That email address or password is not right. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try is" : "tries are"} left before the account is locked for signing.`;
}

export async function verifySignerCheck(
  token: string,
  input: unknown,
  {
    database = getDb(),
    emailService,
    requestMeta = {},
    verifiedMethods = [],
    verifyPassword,
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

  if (parsed.method === "account") {
    const result = await checkSigningCredentials(
      {
        email: parsed.email,
        ipAddress: requestMeta.ipAddress ?? null,
        password: parsed.password,
        signerName: context.signer.name,
        userAgent: requestMeta.userAgent ?? null,
        userId: state.accountUserId!,
      },
      { database, emailService, verifyPassword },
    );

    passed = result.ok;

    if (!result.ok) {
      await recordAuditEvent(
        {
          actorEmail: context.signer.email,
          actorType: "signer",
          envelopeId: context.envelope.id,
          event: "verification_failed",
          ipAddress: requestMeta.ipAddress ?? null,
          metadata: {
            ...signerAuditMetadata(context),
            locked: result.locked,
            method: parsed.method,
          },
          userAgent: requestMeta.userAgent ?? null,
        },
        database,
      );

      throw new SigningMutationError(describeCredentialFailure(result), 400);
    }
  } else if (parsed.method === "access_code") {
    // An access code can be short, so wrong ones are counted per signer and
    // code, over every link and address: a guesser gets a few tries a week,
    // not a few every quarter of an hour. A new code from the sender starts
    // a new count. Each try is counted before the code is compared, so tries
    // sent at the same moment cannot all pass the check; a right one is
    // then taken back off the count.
    const failuresKey = `signing-access-code-failures:${context.signer.id!}:${state.accessCodeHash!}`;
    const attempt = await consumeRateLimit(
      {
        key: failuresKey,
        limit: ACCESS_CODE_MAX_FAILURES,
        windowMs: ACCESS_CODE_FAILURE_WINDOW_MS,
      },
      { database },
    );

    if (!attempt.allowed) {
      throw new SigningMutationError(
        "Too many wrong access codes. Ask the sender for the code, or for a new one.",
        429,
      );
    }

    passed = checkAccessCode(parsed.code, state.accessCodeHash!);

    if (passed) {
      await refundRateLimit(failuresKey, attempt, { database });
    }
  } else {
    // Count the attempt and read the code in one statement, so parallel
    // guesses cannot share an attempt.
    const attempt = await database.query<{
      attempts: number;
      hash: string;
    }>(
      `
        UPDATE signers
        SET email_code_attempts = email_code_attempts + 1
        WHERE id = $1
          AND signing_token_hash = $4
          AND email_code_hash IS NOT NULL
          AND email_code_expires_at >= $2
          AND email_code_attempts < $3
        RETURNING email_code_hash AS hash, email_code_attempts AS attempts
      `,
      [context.signer.id, now, EMAIL_CODE_MAX_ATTEMPTS, hashOpaqueToken(token)],
    );
    const current = attempt.rows[0];

    if (!current) {
      throw new SigningMutationError(
        "That code has expired. Send a new one.",
        410,
      );
    }

    if (checkEmailCode(parsed.code, current.hash)) {
      // Used once: only the request that clears it passes.
      const consumed = await database.query(
        `
          UPDATE signers
          SET email_code_hash = NULL, email_code_expires_at = NULL
          WHERE id = $1 AND email_code_hash = $2
        `,
        [context.signer.id, current.hash],
      );

      passed = consumed.rowCount === 1;
    } else if (current.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      await database.query(
        `
          UPDATE signers
          SET email_code_hash = NULL, email_code_expires_at = NULL
          WHERE id = $1 AND email_code_hash = $2
        `,
        [context.signer.id, current.hash],
      );
    }
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
/**
 * Whether what the signer has typed so far fits the field's box on the
 * finished document, checked as they type, so they learn before they finish.
 * The same check signing makes, with the same fonts.
 */
export async function checkSigningFieldFit(
  token: string,
  input: unknown,
  {
    database = getDb(),
    verifiedMethods = [],
  }: Pick<SubmitSigningOptions, "database" | "verifiedMethods"> = {},
): Promise<{ fits: true } | { fits: false; maxCharacters: number }> {
  const parsed = signingFieldFitRequestSchema.parse(input);
  const context = await resolveSigningContext(token, { database });

  await assertSignerChecksPassed(context, verifiedMethods, database);

  const field = context.fields.find(
    (entry) =>
      entry.id === parsed.fieldId &&
      entry.signerId === context.signer.id &&
      (entry.type === "text" ||
        entry.type === "number" ||
        entry.type === "dropdown"),
  );

  if (!field) {
    throw new SigningMutationError("That field is not yours to fill in.", 404);
  }

  const tooLong = await findTypedValueTooLongForField(
    [{ field, value: parsed.value }],
    context.pages,
  );

  return tooLong
    ? { fits: false, maxCharacters: tooLong.maxCharacters }
    : { fits: true };
}

/**
 * The disclosure this signer reads, filled in for their sender. It is read
 * from the database, not the settings cache, so the signing page and the
 * consent check always agree on the words just after an administrator
 * changes them.
 */
async function readSignerDisclosure(
  context: SigningContext,
  database: DbExecutor,
) {
  // Read fresh, not from the short settings cache, so the words and the
  // support address in them are the ones saved right now.
  const settings = resolveSettings(await readStoredSettings(database));
  const customDisclosure = normalizeCustomDisclosure(
    settings.consentDisclosure,
  );

  const sections = buildDisclosureSections(
    {
      contactAddress: settings.supportAddress ?? context.sender.email,
      senderName: normalizeSenderName(context.sender),
    },
    customDisclosure,
  );

  return {
    customDisclosure,
    sections,
    // A custom disclosure is named by the words as this signer reads them,
    // filled in, so a change to the support address or the sender's name
    // after the page loaded is refused too, and the record holds the words
    // that were shown.
    version:
      customDisclosure === null
        ? getDisclosureVersion(null)
        : getDisclosureVersion(disclosureSectionsAsText(sections)),
  };
}

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

  const disclosure = await readSignerDisclosure(context, database);
  const disclosureVersion = disclosure.version;

  if (parsed.disclosureVersion !== disclosureVersion) {
    throw new SigningMutationError(
      "The disclosure has changed. Reload the page to read the current one.",
      409,
    );
  }

  if (state.consentedAt !== null) {
    return { consentedAt: state.consentedAt };
  }

  const consentedAt = Math.floor(Date.now() / 1000);
  const presentedTokenHash = hashOpaqueToken(token);

  await withTransaction(async (tx) => {
    const updated = await tx.query(
      `
        UPDATE signers
        SET consented_at = $1
        WHERE id = $2
          AND consented_at IS NULL
          AND status = 'notified'
          AND signing_token_hash = $3
      `,
      [consentedAt, context.signer.id, presentedTokenHash],
    );

    if (updated.rowCount !== 1) {
      const current = await queryOne<{
        consentedAt: number | null;
        signingTokenHash: string | null;
      }>(
        tx,
        `
          SELECT
            consented_at AS "consentedAt",
            signing_token_hash AS "signingTokenHash"
          FROM signers
          WHERE id = $1
        `,
        [context.signer.id],
      );

      if (!current || current.signingTokenHash !== presentedTokenHash) {
        throw new SigningMutationError(
          "This signing link is no longer active.",
          409,
        );
      }

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
          disclosureVersion,
          // The built-in words are known from their version. A custom
          // disclosure can be changed or taken away later, so the words the
          // signer saw, filled in as they read them, are kept with the
          // record.
          ...(disclosure.customDisclosure === null
            ? {}
            : {
                disclosureText: disclosureSectionsAsText(disclosure.sections),
              }),
          statement: CONSENT_STATEMENT,
        },
        userAgent: requestMeta.userAgent ?? null,
      },
      tx,
    );
  }, database);

  return { consentedAt };
}

/**
 * What a link that signing, declining or voiding took away should say. It
 * opens nothing: it only tells the signer what became of the envelope, so
 * they are not sent to ask for a new link the sender cannot send. Any other
 * link that opens nothing has expired.
 */
async function getSpentSigningLinkState(
  tokenHash: string,
  database: DbExecutor,
): Promise<SigningUnavailableResponse["state"]> {
  const spent = await queryOne<{
    envelopeStatus: SigningEnvelopeRow["status"];
    signerStatus: SigningSignerRow["status"];
  }>(
    database,
    `
      SELECT
        envelopes.status AS "envelopeStatus",
        signers.status AS "signerStatus"
      FROM signers
      JOIN envelopes ON envelopes.id = signers.envelope_id
      WHERE signers.spent_signing_token_hash = $1
      LIMIT 1
    `,
    [tokenHash],
  );

  switch (spent?.envelopeStatus) {
    case "completed":
      return "completed";
    case "declined":
      return "declined";
    case "voided":
      return "voided";
    case "sent":
      return spent.signerStatus === "signed" ? "already-signed" : "expired";
    default:
      return "expired";
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
    throw new SigningAccessError(
      await getSpentSigningLinkState(hashOpaqueToken(token), database),
    );
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
    throw new SigningAccessError(
      "already-signed",
      isApprover(signer) ? "You've already approved this document." : undefined,
    );
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
    (signingTokenExpiresAt !== null && signingTokenExpiresAt < now) ||
    // The envelope's own deadline, whatever the link says.
    isEnvelopeExpired(envelopeRow, now)
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
  const disclosure = await readSignerDisclosure(context, database);

  const viewedEventId = await recordViewedEventOnce(
    context,
    requestMeta,
    database,
  );
  if (viewedEventId) {
    await notifySenderOfActivity("viewed", viewedEventId, context, database);
  }

  const signerNamesById = new Map(
    context.signers.map((signer) => [signer.id, signer.name] as const),
  );
  const signersById = new Map(
    context.signers.map((signer) => [signer.id, signer] as const),
  );

  const currentSignerFields = context.fields
    .filter((field) => field.signerId === context.signer.id)
    .map((field) => ({
      groupId: field.groupId,
      height: field.height,
      id: field.id,
      label: field.label,
      options: field.options,
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
        const fieldSigner = signersById.get(field.signerId);

        // What the signers of earlier steps entered. Someone signing at the
        // same time may have signed already, but what they entered is not
        // shown: it was not on the page when this signer's turn began.
        return (
          fieldSigner !== undefined &&
          isEarlierStep(fieldSigner, context.signer) &&
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
    fieldFitUrl: getSigningFieldFitUrl(token),
    consentedAt: checkState.consentedAt,
    currentSignerFields,
    disclosure: {
      sections: disclosure.sections,
      statement: CONSENT_STATEMENT,
      version: disclosure.version,
    },
    declineUrl: getSigningDeclineUrl(token),
    documentUrl: getSigningDocumentUrl(token),
    envelopeId: context.envelope.id,
    envelopeTitle: context.envelope.title,
    pageCount: context.envelope.pageCount,
    pages: context.pages,
    part11:
      context.envelope.part11 && context.signer.signatureMeaning
        ? {
            meaning: context.signer.signatureMeaning,
            meaningLabel:
              SIGNATURE_MEANING_DETAILS[context.signer.signatureMeaning].label,
            meaningStatement:
              SIGNATURE_MEANING_DETAILS[context.signer.signatureMeaning]
                .statement,
          }
        : null,
    providerSignature:
      context.envelope.signatureLevel === "advanced" ||
      context.envelope.signatureLevel === "qualified"
        ? {
            level: context.envelope.signatureLevel,
            providerName:
              signingProviderById(context.envelope.signatureProvider ?? "")
                ?.name ?? "the signing provider",
            startUrl: `/api/signing/${encodeURIComponent(token)}/provider/start`,
          }
        : null,
    senderName: normalizeSenderName(context.sender),
    signer: {
      email: context.signer.email,
      id: context.signer.id,
      name: context.signer.name,
      order: context.signer.signOrder,
      role: isApprover(context.signer) ? "approver" : "signer",
    },
    ...(isApprover(context.signer)
      ? { approveUrl: getSigningApproveUrl(token) }
      : {}),
    state: "ready",
    submitUrl: getSigningSubmitUrl(token),
    visibleFields,
  });
}

/**
 * For a Part 11 envelope: checks the signer's email address and password
 * again for this signature, and that they confirmed what it means. Returns
 * what goes in the "signed" audit event, or null for other envelopes.
 */
async function reauthenticatePart11Signer(
  context: ResolvedSigningContext,
  state: SignerCheckState,
  reauthentication:
    { email: string; meaningConfirmed: true; password: string } | undefined,
  {
    database,
    emailService,
    requestMeta,
    verifyPassword,
  }: {
    database: DbPool;
    emailService: EmailService;
    requestMeta: SigningRequestMeta;
    verifyPassword?: PasswordVerifier;
  },
): Promise<Part11SignatureRecord | null> {
  if (!context.envelope.part11 && !state.accountUserId) {
    return null;
  }

  const meaning = context.signer.signatureMeaning;

  if (!state.accountUserId || !meaning) {
    throw new SigningMutationError(
      "This document was sent for Part 11 signatures but has no account or meaning for you. Ask the sender to send it again.",
      409,
    );
  }

  if (!reauthentication) {
    throw new SigningMutationError(
      "Enter your email address and password to sign.",
      400,
    );
  }

  const result = await checkSigningCredentials(
    {
      email: reauthentication.email,
      ipAddress: requestMeta.ipAddress ?? null,
      password: reauthentication.password,
      signerName: context.signer.name,
      userAgent: requestMeta.userAgent ?? null,
      userId: state.accountUserId,
    },
    { database, emailService, verifyPassword },
  );

  if (!result.ok) {
    await recordAuditEvent(
      {
        actorEmail: context.signer.email,
        actorType: "signer",
        envelopeId: context.envelope.id,
        event: "reauthentication_failed",
        ipAddress: requestMeta.ipAddress ?? null,
        metadata: { ...signerAuditMetadata(context), locked: result.locked },
        userAgent: requestMeta.userAgent ?? null,
      },
      database,
    );

    throw new SigningMutationError(describeCredentialFailure(result), 400);
  }

  return {
    credential: "account_password",
    meaning,
    meaningStatement: SIGNATURE_MEANING_DETAILS[meaning].statement,
    reauthenticatedAt: Math.floor(Date.now() / 1000),
    userId: state.accountUserId,
  };
}

/**
 * Makes a provider-signed revision the envelope's current one, within the
 * transaction that records the signature. Refused when another revision was
 * committed since this signer began, so no signature is ever built on a
 * revision that is no longer the latest. Returns the storage key of the
 * revision it replaces (null when it was built on the source PDF), which the
 * new one contains and which can go once the transaction commits.
 */
async function commitProviderRevision(
  tx: DbExecutor,
  envelopeId: string,
  completion: ProviderSignatureCompletion,
  now: number,
): Promise<string | null> {
  // Locked, so the revision read here is the one the update below replaces.
  // The lock an UPDATE takes, as in lockSentEnvelope: a stronger one would
  // also stop audit events being added to this envelope meanwhile.
  const current = await queryOne<{ revisionKey: string | null }>(
    tx,
    `
      SELECT revision_key AS "revisionKey"
      FROM envelopes
      WHERE id = $1
        AND revision_sha256 IS NOT DISTINCT FROM $2
      FOR NO KEY UPDATE
    `,
    [envelopeId, completion.baseSha256],
  );

  if (!current) {
    throw new SigningMutationError(
      "The document changed while you were signing. Open your signing link again.",
      409,
    );
  }

  await tx.query(
    `
      UPDATE envelopes
      SET revision_key = $1, revision_sha256 = $2
      WHERE id = $3
    `,
    [completion.revision.key, completion.revision.sha256, envelopeId],
  );

  const session = await tx.query(
    `
      UPDATE provider_signing_sessions
      SET state = 'completed', completed_at = $1, secret_data = ''
      WHERE id = $2 AND envelope_id = $3 AND state = 'signing'
    `,
    [now, completion.sessionId, envelopeId],
  );

  if (session.rowCount !== 1) {
    throw new SigningMutationError("This signing session has ended.", 409);
  }

  return current.revisionKey === completion.revision.key
    ? null
    : current.revisionKey;
}

async function deleteReplacedRevision(
  key: string | null,
  storageService: StorageService,
) {
  if (key) {
    await storageService.deleteObject(key).catch(() => undefined);
  }
}

/**
 * Refuses a submission once the signer has signed, read while the envelope
 * is locked. The last signer's submission makes the envelope's final files,
 * which have fixed keys, only after this, under that lock. So of two by the
 * same signer at once (a double click, or two returns from a signing
 * provider), the second waits and stops here: it never writes over, or
 * deletes, the files the first one saved.
 */
async function assertStillSignersTurn(
  envelopeId: string,
  signerId: string,
  tx: DbExecutor,
) {
  const turn = await tx.query(
    `
      SELECT 1 FROM signers
      WHERE id = $1 AND envelope_id = $2 AND status = 'notified'
    `,
    [signerId, envelopeId],
  );

  if (turn.rowCount !== 1) {
    throw new SigningMutationError(
      "This signing link is no longer active.",
      409,
    );
  }
}

type SigningContext = Awaited<ReturnType<typeof resolveSigningContext>>;

/**
 * Refuses an answer too long to be read in its box on the finished document,
 * before anything is saved, so the signer can shorten it. Without this the
 * value would be drawn so small that no one could read it. A dropdown choice
 * is the sender's text, which the signer cannot shorten, so it is taken and
 * drawn whole however small.
 */
async function assertTypedValuesFitTheirFields(
  context: SigningContext,
  fieldUpdates: ReadonlyMap<string, FieldPersistenceUpdate>,
) {
  const entries = context.fields.flatMap((field) => {
    const value = field.id ? fieldUpdates.get(field.id)?.value : null;

    return (field.type === "text" || field.type === "number") && value
      ? [{ field, value }]
      : [];
  });
  const tooLong = await findTypedValueTooLongForField(entries, context.pages);

  if (tooLong) {
    throw new SigningMutationError(
      `An answer on page ${tooLong.page} is too long to fit in its box on the document. Shorten it to ${tooLong.maxCharacters} characters or fewer, or ask the sender for a bigger box.`,
      400,
    );
  }
}

/**
 * What the signer's submission changes: each of their fields' new value,
 * checked against what the field accepts, and the drawn signatures to store.
 */
function buildSignerSubmission(
  context: SigningContext,
  parsedInput: SigningSubmission,
  submittedAt: number,
) {
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

  // An approver has no fields: saving fields and sending both refuse one
  // that does, and so does the database. Should one turn up all the same,
  // nothing is approved, rather than leaving their fields empty.
  if (isApprover(context.signer)) {
    if (currentSignerFields.length > 0) {
      throw new SigningMutationError(
        "This document has fields for an approver. Ask the sender to send it again.",
        409,
      );
    }

    return {
      currentSignerFields,
      currentSignerId,
      drawnSignatureUploads: [] as Array<{
        body: Uint8Array;
        imageKey: string;
      }>,
      fieldUpdates: new Map<string, FieldPersistenceUpdate>(),
    };
  }

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

  // Names this submission's drawn signatures apart from any other's.
  const submissionId = randomUUID();
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
        submissionId,
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

    // The name the sender gave this signer, as it stands when they sign.
    if (field.type === "name") {
      fieldUpdates.set(field.id, {
        checked: null,
        fieldId: field.id,
        imageKey: null,
        inputMethod: "auto",
        submittedAt,
        value: context.signer.name,
      });
      continue;
    }

    if (
      field.type === "text" ||
      field.type === "number" ||
      field.type === "dropdown"
    ) {
      const trimmedValue =
        submission?.type === field.type ? submission.value.trim() : null;

      // What goes on the document is exactly what the signer entered, so a
      // number must be one and a choice must be one the sender offered.
      const entryProblem = trimmedValue
        ? describeEntryProblem(field, trimmedValue)
        : null;

      if (entryProblem) {
        throw new SigningMutationError(entryProblem, 400);
      }

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
      submission?.type === "checkbox" || submission?.type === "radio"
        ? submission.checked
        : false;

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

  assertRadioGroupsAnswered(currentSignerFields, fieldUpdates);

  return {
    currentSignerFields,
    currentSignerId,
    drawnSignatureUploads,
    fieldUpdates,
  };
}

/**
 * Raised inside a signature's or a decline's transaction when the rows it
 * holds locked show that the signing order moved on after the submission
 * was prepared: another signer of the same step signed at the same moment.
 * The transaction rolls back and the whole submission starts again from
 * what the database now says.
 */
class SigningRouteChangedError extends Error {
  constructor() {
    super("Another signer of this step signed at the same moment.");
    this.name = "SigningRouteChangedError";
  }
}

/**
 * Enough for every signer of a step submitting at the same moment: each
 * attempt that loses waits for one that wins, and there are no more than
 * MAX_SIGNERS_CEILING signers.
 */
const MAX_ROUTE_ATTEMPTS = 5;

async function retryWhileRouteChanges<T>(attempt: () => Promise<T>) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof SigningRouteChangedError)) {
        throw error;
      }

      if (tries >= MAX_ROUTE_ATTEMPTS) {
        throw new SigningMutationError(
          "Other signers were signing at the same moment. Try again.",
          409,
        );
      }
    }
  }
}

export async function submitSigningForToken(
  token: string,
  input: unknown,
  options: SubmitSigningOptions = {},
): Promise<SigningSubmitResponse> {
  return retryWhileRouteChanges(() =>
    submitSigningOnce(token, input, options, { approval: false }),
  );
}

/**
 * An approver approves. Everything a signature goes through applies, from
 * the checks and the consent to the locking and the restart when the route
 * changed underneath it, so of a signer and an approver of one step who
 * finish at the same moment exactly one moves the order on, as with two
 * signers. Only what is recorded differs: no fields, and an "approved"
 * event instead of "signed".
 */
export async function approveSigningForToken(
  token: string,
  input: unknown,
  options: Omit<SubmitSigningOptions, "providerSignature"> = {},
): Promise<SigningSubmitResponse> {
  return retryWhileRouteChanges(() =>
    submitSigningOnce(token, input, options, { approval: true }),
  );
}

async function submitSigningOnce(
  token: string,
  input: unknown,
  {
    database = getDb(),
    emailService: givenEmailService,
    providerSignature,
    requestMeta = {},
    storageService: givenStorageService,
    verifiedMethods = [],
    verifyPassword,
  }: SubmitSigningOptions = {},
  { approval }: { approval: boolean },
): Promise<SigningSubmitResponse> {
  const parsedInput: SigningSubmission = approval
    ? {
        ...approvalSubmissionSchema.parse(input),
        fields: [],
      }
    : signingSubmissionSchema.parse(input);
  const context = await resolveSigningContext(token, { database });
  // Signed inside another app: no email to the next signer, and the
  // evidence says where.
  const embedded = context.signer.id
    ? await readEmbedEvidence(context.envelope.id, context.signer.id, database)
    : null;
  const doneRedirectPath = embedded?.origin
    ? `/embed/sign/${encodeURIComponent(token)}/done?${new URLSearchParams({ origin: embedded.origin, title: context.envelope.title, ...(approval ? { approved: "1" } : {}) }).toString()}`
    : getSigningDoneRedirectPath(token, context.envelope.title, approval);

  if (approval !== isApprover(context.signer)) {
    throw new SigningMutationError(
      approval
        ? "This link is for signing, not approving."
        : "This link is for approving. Approve or reject the document from the page.",
      409,
    );
  }

  // Approvers are refused at sending on Part 11 envelopes and on envelopes
  // signed through a signing provider (envelopes.ts). Checked again here so
  // an approval can never stand where one of those signatures belongs.
  if (
    approval &&
    (context.envelope.part11 ||
      (context.envelope.signatureLevel ?? "simple") !== "simple" ||
      providerSignature)
  ) {
    throw new SigningMutationError(
      "This document cannot be approved here. Ask the sender to send it again.",
      409,
    );
  }

  // A document sent for advanced or qualified signatures is signed by each
  // signer's provider, never by a plain submit, and the other way round.
  if (approval) {
    // Nothing to check: no provider is involved in an approval.
  } else if ((context.envelope.signatureLevel ?? "simple") === "simple") {
    if (providerSignature) {
      throw new SigningMutationError(
        "This document is not signed through a signing provider.",
        409,
      );
    }
  } else if (!providerSignature) {
    throw new SigningMutationError(
      "This document is signed with a certificate in your own name. Continue from the signing page.",
      409,
    );
  }

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

  const emailService = givenEmailService ?? createLazyEmailService();
  const part11Signature = await reauthenticatePart11Signer(
    context,
    signerChecks.state,
    parsedInput.reauthentication,
    { database, emailService, requestMeta, verifyPassword },
  );
  const storageService = givenStorageService ?? createStorageService();
  // When the signer signed. Through a provider, that is when they left for
  // it, the time the signed revision itself states. The next signer's turn
  // starts now, however long the provider took.
  const routedAt = Math.floor(Date.now() / 1000);
  const submittedAt = providerSignature?.submittedAt ?? routedAt;
  // The revision this signer's replaces, deleted once the change is saved.
  let replacedRevisionKey: string | null = null;
  const {
    currentSignerFields,
    currentSignerId,
    drawnSignatureUploads,
    fieldUpdates,
  } = buildSignerSubmission(context, parsedInput, submittedAt);

  await assertTypedValuesFitTheirFields(context, fieldUpdates);
  const presentedTokenHash = hashOpaqueToken(token);

  let signingStatePersisted = false;

  try {
    // Whether this is the last signature, as far as can be told before the
    // envelope is locked. Everyone else has signed: this submission makes
    // the final files. Anyone else still to sign, in this step or a later
    // one: it records the signature and moves the order on if this step is
    // done. Signers of the same step can submit at the same moment, so the
    // second of them may find, once it holds the envelope, that the first
    // has signed meanwhile and it is the last after all. It then starts
    // again (SigningRouteChangedError), and is the last signature this time.
    const isLastSignature = context.signers.every(
      (signer) => signer.id === currentSignerId || signer.status === "signed",
    );
    // Each signer of the next step gets a link of their own. When it ends
    // is settled once the envelope is locked, from the deadline then.
    let nextSignerDeliveries: {
      email: string;
      id: string;
      name: string;
      role: "approver" | "signer";
      tokenHash: string;
      url: string;
    }[] = [];

    for (const upload of drawnSignatureUploads) {
      await storageService.putObject({
        body: upload.body,
        contentType: "image/png",
        key: upload.imageKey,
      });
    }

    const signedAuditEvent = buildSignedAuditEvent({
      authMethods: signerChecks.passed,
      embedded,
      envelopeId: context.envelope.id,
      part11: part11Signature,
      providerSignature: providerSignature?.evidence ?? null,
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

    if (!isLastSignature) {
      // The deadline the next signer is given. The sender can move it while
      // this signer submits, and moving it only reaches the signer whose
      // turn it is then. So it is read here, where this update holds the
      // envelope's row and a change of deadline has to wait its turn.
      let nextSignerDeadline = context.envelope.expiresAt ?? null;

      await withTransaction(async (tx) => {
        const lockedEnvelope = await queryOne<{ expiresAt: number | null }>(
          tx,
          `
            UPDATE envelopes
            SET updated_at = $1
            WHERE id = $2
              AND status = 'sent'
            RETURNING expires_at AS "expiresAt"
          `,
          [routedAt, context.envelope.id],
        );

        if (!lockedEnvelope) {
          // Voided or declined since the page was opened.
          throw new SigningMutationError(
            "This signing link is no longer active.",
            409,
          );
        }

        nextSignerDeadline = lockedEnvelope.expiresAt;

        if (providerSignature) {
          replacedRevisionKey = await commitProviderRevision(
            tx,
            context.envelope.id,
            providerSignature,
            routedAt,
          );
        }

        await lockSignerForPresentedToken(tx, {
          envelopeId: context.envelope.id,
          signerId: currentSignerId,
          tokenHash: presentedTokenHash,
        });

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
              spent_signing_token_hash = signing_token_hash,
              signing_token_hash = NULL,
              signing_token_expires_at = NULL,
              signed_at = $1,
              updated_at = $2
            WHERE id = $3
              AND envelope_id = $4
              AND status = 'notified'
              AND signing_token_hash = $5
          `,
          [
            submittedAt,
            submittedAt,
            currentSignerId,
            context.envelope.id,
            presentedTokenHash,
          ],
        );

        if (signedSignerResult.rowCount !== 1) {
          throw new SigningMutationError(
            "This signing link is no longer active.",
            409,
          );
        }

        // Who is still to sign, read with this signature in place and while
        // the envelope's row is held. Every other signature, decline and
        // void takes that row first, so nothing here can change until this
        // transaction ends, and of two signers of one step who submit at
        // the same moment exactly one finds the step finished.
        const route = routeAfterSignatures(
          (await listSignerRows(context.envelope.id, tx)).map(mapSignerRow),
        );

        if (route.waiting.length === 0 && route.next.length === 0) {
          // Everyone else signed while this was being prepared: this is the
          // last signature, and the envelope's final files have to be made.
          throw new SigningRouteChangedError();
        }

        const deliveries: typeof nextSignerDeliveries = [];

        for (const nextSigner of route.next) {
          // Each signer of the next step gets a link of their own.
          const link = await issueSigningLink({ issuedAt: routedAt });
          const activatedNextSigner = await queryOne<{
            email: string;
            name: string;
            role: "approver" | "signer";
          }>(
            tx,
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
                AND role IN ('signer', 'approver')
                AND status = 'pending'
              RETURNING name, email, role
            `,
            [
              link.tokenHash,
              nextSignerLinkExpiresAt(lockedEnvelope.expiresAt, routedAt),
              routedAt,
              routedAt,
              routedAt,
              nextSigner.id,
              context.envelope.id,
            ],
          );

          if (!activatedNextSigner || !nextSigner.id) {
            throw new SigningMutationError(
              "Unable to activate the next signer for this envelope.",
              500,
            );
          }

          deliveries.push({
            email: activatedNextSigner.email,
            id: nextSigner.id,
            name: activatedNextSigner.name,
            role: activatedNextSigner.role,
            tokenHash: link.tokenHash,
            url: link.url,
          });
        }

        nextSignerDeliveries = deliveries;

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
      await deleteReplacedRevision(replacedRevisionKey, storageService);

      // Nobody to invite while others in this step are still signing. In
      // an embedded envelope nobody is emailed: the app starts the next
      // step's turns, and the signer.signed webhook shows who is next.
      const invitations = embedded ? [] : nextSignerDeliveries;

      for (const nextSignerDelivery of invitations) {
        try {
          const delivery = await sendSigningInvitation({
            database,
            emailService,
            envelopeId: context.envelope.id,
            signerId: nextSignerDelivery.id,
            tokenHash: nextSignerDelivery.tokenHash,
            message: buildSigningInvitationEmail({
              branding: await getBranding(),
              envelopeTitle: context.envelope.title,
              expiresAt: nextSignerDeadline,
              invitation: await readInvitationCopy(
                context.envelope.id,
                database,
              ),
              role: nextSignerDelivery.role,
              senderName: normalizeSenderName(context.sender),
              signerEmail: nextSignerDelivery.email,
              signerName: nextSignerDelivery.name,
              signingUrl: nextSignerDelivery.url,
            }),
          });

          await recordEmailSent(
            {
              envelopeId: context.envelope.id,
              messageId: delivery.messageId,
              recipient: nextSignerDelivery.email,
              signerId: nextSignerDelivery.id,
              template: "signing_invitation",
            },
            database,
          );
        } catch (error) {
          console.error(
            `Failed to send next signer invitation for envelope ${context.envelope.id} to ${nextSignerDelivery.email}:`,
            error,
          );
        }
      }

      await notifySenderOfActivity(
        approval ? "approved" : "signed",
        signedAuditEvent.id,
        context,
        database,
        emailService,
      );

      return signingSubmitResponseSchema.parse({
        envelopeId: context.envelope.id,
        redirectPath: doneRedirectPath,
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

    const copyRecipients = await listCopyRecipientRows(
      context.envelope.id,
      database,
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

    // The seal's key and the install's name, read before the transaction:
    // sealing inside it then needs no second connection from the pool.
    const seal = await loadInstallSealer();
    // Set once this submission may have stored the final files.
    let finalArtifactsStored = false;
    let finalArtifacts: Awaited<ReturnType<typeof finalizeEnvelope>>;

    try {
      finalArtifacts = await withTransaction(async (tx) => {
        await lockSentEnvelope(context.envelope.id, tx);
        await assertStillSignersTurn(context.envelope.id, currentSignerId, tx);
        await lockSignerForPresentedToken(tx, {
          envelopeId: context.envelope.id,
          signerId: currentSignerId,
          tokenHash: presentedTokenHash,
        });

        // The final files are made from the signers, fields and audit trail
        // read before the lock, which hold everyone else's signature: a
        // signature cannot be taken back. Checked again here all the same,
        // so the envelope is never finished while anyone is still to sign.
        const stillToSign = await queryOne<{ id: string }>(
          tx,
          `
            SELECT id FROM signers
            WHERE envelope_id = $1
              AND role IN ('signer', 'approver')
              AND id <> $2
              AND status <> 'signed'
            LIMIT 1
          `,
          [context.envelope.id, currentSignerId],
        );

        if (stillToSign) {
          throw new SigningRouteChangedError();
        }

        // The audit trail the certificate shows, read with the envelope and
        // its audit chain held: an event recorded since the link was opened
        // (a view, an email, a reminder) is on it, and one recorded from
        // now on waits until the envelope is finished.
        await lockEnvelopeAuditChain(context.envelope.id, tx);

        const auditEvents = [
          ...(await listAuditEventsForEnvelope(context.envelope.id, tx)),
          signedAuditEvent,
        ];

        // Made while the envelope is locked: the files have fixed keys, and
        // a second submission at the same time waits, then stops above.
        finalArtifactsStored = true;

        const artifacts = await finalizeEnvelope(
          {
            auditEvents,
            copyRecipients,
            envelope: context.envelope,
            fields: completedFields,
            pages: context.pages,
            signers: completedSigners,
            sourcePdf: {
              bucketName: sourcePdfHead.bucketName,
              key: context.envelope.sourcePdfKey,
            },
          },
          {
            seal,
            signedRevision: providerSignature?.revision.bytes,
            storageService,
          },
        );

        if (providerSignature) {
          replacedRevisionKey = await commitProviderRevision(
            tx,
            context.envelope.id,
            providerSignature,
            routedAt,
          );
        }

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
              spent_signing_token_hash = signing_token_hash,
              signing_token_hash = NULL,
              signing_token_expires_at = NULL,
              signed_at = $1,
              updated_at = $2
            WHERE id = $3
              AND envelope_id = $4
              AND status = 'notified'
              AND signing_token_hash = $5
          `,
          [
            submittedAt,
            submittedAt,
            currentSignerId,
            context.envelope.id,
            presentedTokenHash,
          ],
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
            artifacts.signedPdf.key,
            artifacts.certificate.key,
            artifacts.generatedAt,
            artifacts.generatedAt,
            context.envelope.id,
            artifacts.signedPdf.sha256,
            artifacts.certificate.sha256,
            artifacts.recipientCertificate.sha256,
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
            createdAt: artifacts.generatedAt,
            envelopeId: context.envelope.id,
            event: "completed",
            metadata: null,
          },
          tx,
        );

        return artifacts;
      }, database);
      signingStatePersisted = true;
      await deleteReplacedRevision(replacedRevisionKey, storageService);
    } catch (error) {
      if (finalArtifactsStored) {
        await Promise.all(
          storedArtifactKeys.map((key) =>
            storageService.deleteObject(key).catch(() => undefined),
          ),
        );
      }

      throw error;
    }

    try {
      await sendCompletionEmails({
        attachments: {
          recipientCertificate: finalArtifacts.recipientCertificate.body,
          signedPdf: finalArtifacts.signedPdf.body,
        },
        copyRecipients,
        database,
        emailService,
        envelopeId: context.envelope.id,
        envelopeTitle: context.envelope.title,
        sender: context.sender,
        senderUserId: context.envelope.userId,
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
      redirectPath: doneRedirectPath,
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

export type PreparedSignerSubmission = {
  context: SigningContext;
  /** Drawn signatures by the key they will be stored under. */
  images: Map<string, Uint8Array>;
  /** The signer's fields with the submitted values, for their revision. */
  signerFields: ReturnType<typeof fieldRecordSchema.parse>[];
  /** Where the signer is in the signing order, from 0. */
  signerIndex: number;
  submittedAt: number;
};

/**
 * Checks a submission the way submitting does, without saving anything: for
 * a signer who signs through a signing provider, whose signature is made
 * before their submission is saved. See provider-signing.ts.
 */
export async function prepareSignerSubmission(
  token: string,
  input: unknown,
  {
    database = getDb(),
    submittedAt = Math.floor(Date.now() / 1000),
    verifiedMethods = [],
  }: {
    database?: DbPool;
    submittedAt?: number;
    verifiedMethods?: readonly SignerCheckMethod[];
  } = {},
): Promise<PreparedSignerSubmission> {
  const parsedInput = signingSubmissionSchema.parse(input);
  const context = await resolveSigningContext(token, { database });

  if (
    (context.envelope.signatureLevel ?? "simple") === "simple" ||
    isApprover(context.signer)
  ) {
    throw new SigningMutationError(
      "This document is not signed through a signing provider.",
      409,
    );
  }

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

  const { currentSignerId, drawnSignatureUploads, fieldUpdates } =
    buildSignerSubmission(context, parsedInput, submittedAt);

  await assertTypedValuesFitTheirFields(context, fieldUpdates);

  return {
    context,
    images: new Map(
      drawnSignatureUploads.map((upload) => [upload.imageKey, upload.body]),
    ),
    signerFields: applyFieldUpdatesToRecords(
      context.fields,
      fieldUpdates,
      submittedAt,
    ).filter((field) => field.signerId === currentSignerId),
    signerIndex: context.signers.findIndex(
      (signer) => signer.id === currentSignerId,
    ),
    submittedAt,
  };
}

export async function declineSigningForToken(
  token: string,
  input: unknown,
  options: SubmitSigningOptions = {},
): Promise<SigningDeclineResponse> {
  return retryWhileRouteChanges(() =>
    declineSigningOnce(token, input, options),
  );
}

async function declineSigningOnce(
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

  const signerChecks = await assertSignerChecksPassed(
    context,
    verifiedMethods,
    database,
  );
  const emailService = createLazyEmailService();
  const storageService = createStorageService();
  const currentSignerId = context.signer.id;
  const presentedTokenHash = hashOpaqueToken(token);

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

  // Declined inside another app: the certificate says where, not that an
  // emailed link was used.
  const embedded = await readEmbedEvidence(
    context.envelope.id,
    currentSignerId,
    database,
  );
  const declinedAuditEvent = buildDeclinedAuditEvent({
    authMethods: signerChecks.passed,
    declinedAt,
    embedded,
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
  const storedCertificateKeys: string[] = [];
  // The seal's key and the install's name, read before the transaction:
  // sealing inside it then needs no second connection from the pool.
  const seal = await loadInstallSealer();

  await withTransaction(async (tx) => {
    await lockSentEnvelope(context.envelope.id, tx);
    await assertStillSignersTurn(context.envelope.id, currentSignerId, tx);
    await lockSignerForPresentedToken(tx, {
      envelopeId: context.envelope.id,
      signerId: currentSignerId,
      tokenHash: presentedTokenHash,
    });

    // The certificates below are made from the recipients read when the link
    // was opened. If the sender corrected one of them since, they would name
    // the old person and leave the correction out, so nothing is stored. A
    // correction cannot commit while this lock is held, so comparing here
    // covers the whole window.
    const recipientsNow = await tx.query<{
      email: string;
      id: string;
      name: string;
    }>(
      `
        SELECT id, name, email FROM signers
        WHERE envelope_id = $1 AND id = ANY($2::text[])
      `,
      [context.envelope.id, context.signers.map((signer) => signer.id)],
    );
    const recipientsChanged =
      recipientsNow.rows.length !== context.signers.length ||
      recipientsNow.rows.some((row) => {
        const seen = context.signers.find((signer) => signer.id === row.id);

        return !seen || seen.name !== row.name || seen.email !== row.email;
      });

    if (recipientsChanged) {
      throw new SigningMutationError(
        "This envelope changed while you were declining. Open your signing link again.",
        409,
      );
    }

    // The same for where everyone else stands. A signer of the same step
    // who signed a moment ago would otherwise be shown on the certificates
    // as still waiting, without their signature in the audit trail they
    // show. Started again, the decline reads them as they are now.
    const statusesNow = await tx.query<{ id: string; status: string }>(
      `
        SELECT id, status FROM signers
        WHERE envelope_id = $1 AND role IN ('signer', 'approver') AND id <> $2
      `,
      [context.envelope.id, currentSignerId],
    );

    if (
      statusesNow.rows.some(
        (row) =>
          context.signers.find((signer) => signer.id === row.id)?.status !==
          row.status,
      )
    ) {
      throw new SigningRouteChangedError();
    }

    // The audit trail the certificates show, read with the envelope and its
    // audit chain held, so an event recorded since the link was opened is
    // on them and none can be added before the decline is.
    await lockEnvelopeAuditChain(context.envelope.id, tx);

    const auditEvents = [
      ...(await listAuditEventsForEnvelope(context.envelope.id, tx)),
      declinedAuditEvent,
    ];

    // Made while the envelope is locked: the certificates have fixed keys,
    // and a void, the last signature or a second decline at the same time
    // waits, then stops above without touching the files this one saved.
    const certificate = await storeEnvelopeCertificatePdf(
      {
        auditEvents,
        certificate: canonicalCertificate,
        envelope: declinedEnvelope,
        signers: declinedSigners,
      },
      {
        seal,
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
        seal,
        storageService,
      },
    );
    storedCertificateKeys.push(recipientCertificate.key);

    const declinedSignerResult = await tx.query(
      `
        UPDATE signers
        SET
          status = 'declined',
          spent_signing_token_hash = signing_token_hash,
          signing_token_hash = NULL,
          signing_token_expires_at = NULL,
          declined_at = $1,
          decline_reason = $2,
          updated_at = $3
        WHERE id = $4
          AND envelope_id = $5
          AND status = 'notified'
          AND signing_token_hash = $6
      `,
      [
        declinedAt,
        declineReason ?? null,
        declinedAt,
        currentSignerId,
        context.envelope.id,
        presentedTokenHash,
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
        recipientCertificate.sha256,
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
  }, database).catch(async (error: unknown) => {
    // Only files this call stored, so only once the envelope was its to end.
    // That includes a failed COMMIT: the cleanup keeps the files if the
    // envelope did end after all.
    if (storedCertificateKeys.length > 0) {
      await removeUnclaimedEnvelopeCertificates(
        {
          envelopeId: context.envelope.id,
          keys: storedCertificateKeys,
          storageService,
        },
        database,
      );
    }

    throw error;
  });

  try {
    const delivery = await emailService.send(
      buildDeclineNotificationEmail({
        branding: await getBranding(),
        declineReason,
        envelopeId: context.envelope.id,
        envelopeTitle: context.envelope.title,
        rejected: isApprover(context.signer),
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
