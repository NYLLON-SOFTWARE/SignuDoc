import { randomUUID } from "node:crypto";

import { type Branding } from "./branding.ts";
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
  deadlineFromDays,
  formatDeadline,
  isEnvelopeExpired,
  signingLinkLifetimeSeconds,
} from "./envelope-deadline.ts";
import {
  countAnswerableFields,
  describeChoiceFieldProblem,
  findChoiceFieldProblem,
} from "./field-choices.ts";
import { idSchema } from "./schemas/common.ts";
import {
  changeDeadlineResponseSchema,
  changeRemindersResponseSchema,
  copyEnvelopeResponseSchema,
  envelopeListFiltersSchema,
  type AuditEventRecord,
  type ChangeDeadlineResponse,
  type ChangeRemindersResponse,
  type CopyEnvelopeResponse,
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
  correctSentSignerResponseSchema,
  correctSentSignerSchema,
  duplicateCopyRecipientEmailMessage,
  duplicateSignerEmailMessage,
  replaceSignersResponseSchema,
  replaceSignersSchema,
  signerRecordSchema,
  type CopyRecipientRecord,
  type CorrectSentSignerResponse,
  type ReplaceSignersResponse,
  type SignerRecord,
} from "./schemas/signer.ts";
import {
  describePart11SignerProblem,
  findSignerAccounts,
  parseSignatureMeaning,
  signatureMeaningLabel,
} from "./part11.ts";
import { getBranding, readStoredSettings } from "./settings.ts";
import { type RecipientRole, type SignatureMeaning } from "./types/domain.ts";
import { importPdfDocument } from "./services/document-import.ts";
import {
  describeSignerCorrectedEvent,
  listAuditEventsForEnvelope,
  lockEnvelopeAuditChain,
  recordAuditEvent,
  recordEmailSent,
} from "./services/audit.ts";
import {
  createEmailService,
  EMAIL_NOT_CONNECTED_MESSAGE,
  isEmailNotConnectedError,
  resolveEmailAddresses,
  type EmailService,
} from "./services/email.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import { buildSigningInvitationEmail } from "./services/signing-invitation-email.ts";
import {
  findTypedValueTooLongForField,
  loadInstallSealer,
  storeEnvelopeCertificatePdf,
  storeRecipientEnvelopeCertificatePdf,
} from "./services/pdf-finalize.ts";
import {
  issueSigningLink,
  type IssuedSigningLink,
} from "./services/signing-links.ts";
import {
  buildEnvelopeCertificateKey,
  buildEnvelopeOriginalPdfKey,
  buildEnvelopeThumbnailKey,
} from "./services/storage-keys.ts";
import {
  configuredSigningProvider,
  signingProviderById,
  type SigningProviderId,
} from "./services/signing-providers.ts";
import {
  createStorageService,
  StorageObjectNotFoundError,
  type StorageObjectStream,
  type StorageService,
} from "./services/storage.ts";
import {
  assertThumbnailImage,
  buildThumbnailEtag,
  matchesEtag,
  THUMBNAIL_CONTENT_TYPE,
} from "./services/thumbnails.ts";
import {
  formatReminderAvailableAt,
  getManualNudgeAvailableAt,
  isManualNudgeAvailable,
} from "./services/reminders.ts";
import {
  canAccessEnvelopeFolderCondition,
  formatEnvelopeOwner,
  resolveEnvelopeViewerAccess,
  sharesTeamCondition,
} from "./envelope-access.ts";
import { requireWritableFolder, TeamError } from "./teams.ts";
import { PERMITTED_USE_VERSION } from "./permitted-uses.ts";
import { hashAccessCode } from "./signer-checks.ts";
import {
  describeSignerLimit,
  getMaxSignersPerEnvelope,
} from "./signer-limit.ts";
import {
  firstStepSigners,
  hasSharedSigningStep,
  joinNames,
  normalizeSigningSteps,
  signingStepOf,
  SigningStepError,
} from "./signing-steps.ts";
import { escapeHtml } from "./utils/html.ts";
import { hasEmbedOrigins, isEmbeddedEnvelope } from "./embedding.ts";
import { releaseSentWebhook } from "./webhooks/outbox.ts";

type CreateDraftEnvelopeOptions = {
  database?: DbPool;
  storageService?: StorageService;
};

type CreateDraftEnvelopeInput = {
  folderId?: string;
  sourcePdf: {
    body: Uint8Array;
    contentType?: string | null;
    filename: string;
  };
  title: string;
};

type SendDraftEnvelopeInput = {
  /** The API key that sent it, recorded in the audit trail. */
  apiKeyId?: string | null;
  /**
   * "embedded": signers sign inside another app (see embedding.ts), so no
   * invitations or reminders are emailed. API only. "email" by default.
   */
  delivery?: "email" | "embedded";
  /** How many days signers get. The default applies when left out. */
  expiresInDays?: number;
  /** Days between automatic reminders. Null or left out means none. */
  reminderIntervalDays?: number | null;
  /**
   * Advanced or qualified: each signer signs with a certificate in their
   * own name through the install's signing provider. Simple by default.
   */
  signatureLevel?: "advanced" | "qualified" | "simple";
  ipAddress?: string | null;
  senderEmail: string;
  senderName: string;
  userAgent?: string | null;
};

type VoidEnvelopeInput = {
  ipAddress?: string | null;
  /** Why it is voided. Required for a Part 11 envelope. */
  reason?: string | null;
  senderEmail: string;
  senderName: string;
  userAgent?: string | null;
};

type CorrectSentEnvelopeSignerContext = {
  ipAddress?: string | null;
  senderEmail: string;
  senderName: string;
  userAgent?: string | null;
};

type CorrectSentEnvelopeSignerOptions = {
  database?: DbPool;
  emailService?: EmailService;
  nowUnixTimestamp?: number;
};

type ExpectedRecipient = { email: string; name: string };

type SendDraftEnvelopeOptions = {
  database?: DbPool;
  /**
   * The people the caller confirmed. When given, the draft is sent only if
   * its signers, in signing order, and its copy recipients are exactly
   * these. The check runs on the parties the send holds unchanged until
   * the invitation goes out.
   */
  expectedRecipients?: {
    copyRecipients: readonly ExpectedRecipient[];
    signers: readonly ExpectedRecipient[];
  };
};

export const draftRecipientsChangedMessage =
  "This draft's recipients were changed after the list was confirmed, so it was not sent. Check the draft and send it from there.";

type VoidEnvelopeOptions = {
  database?: DbPool;
  emailService?: EmailService;
  storageService?: StorageService;
};

type EnvelopeRow = {
  completedAt: number | null;
  createdAt: number;
  declinedAt: number | null;
  evidenceKey: string | null;
  expiresAt: number | null;
  id: string;
  reminderIntervalDays: number | null;
  pageCount: number;
  part11: boolean;
  sentAt: number | null;
  signatureLevel: "advanced" | "qualified" | "simple";
  signatureProvider: string | null;
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
  role: RecipientRole;
  signatureMeaning: SignatureMeaning | null;
  signedAt: number | null;
  signOrder: number;
  signingStep: number | null;
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
  groupId: string | null;
  height: number;
  id: string;
  imageKey: string | null;
  inputMethod: FieldRecord["inputMethod"] | null;
  label: string | null;
  options: string[] | null;
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

// Fields shown in the envelope detail per-signer summary ("N fields assigned"
// / "N fields completed"). Includes auto-filled Date and Name fields so the
// count matches Place fields and Review; the signing page's remaining-required
// counter tracks interactive signer actions separately.
function shouldCountFieldForSignerSummary(
  field: Pick<FieldRecord, "required" | "type">,
): boolean {
  if (field.type === "signature" || field.type === "initials") {
    return true;
  }

  if (
    field.type === "date" ||
    field.type === "name" ||
    field.type === "text" ||
    field.type === "number" ||
    field.type === "dropdown"
  ) {
    return true;
  }

  if (field.type === "checkbox" || field.type === "radio") {
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
  /** Out for signature and past its deadline. */
  expired?: boolean;
  id: string;
  searchableEmails: readonly string[];
  /** Who sent it, in a team's list or in an administrator's of all. */
  senderLabel?: string;
  status: EnvelopeRecord["status"];
  /** What the status pill says: the status, or how far signing has got. */
  statusLabel: string;
  title: string;
};

type ReviewFieldSummary =
  | "Checkbox"
  | "Date"
  | "Dropdown"
  | "Initials"
  | "Name"
  | "Number"
  | "Radio group"
  | "Signature"
  | "Text";

export type ReviewSignerSummary = {
  email: string;
  fieldSummaries: readonly ReviewFieldSummary[];
  id: string;
  name: string;
  order: number;
  /** A signer, or an approver who has no fields. */
  role: RecipientRole;
  /** The step of the signing order; signers who share one sign together. */
  step: number;
};

export type ReviewEnvelopeData = {
  canSend: boolean;
  /**
   * The install's signing provider, when the sender may choose signatures
   * in the signers' own names. Null without one, or in Part 11 mode.
   */
  signingProvider: { name: string } | null;
  copyRecipients: readonly CopyRecipientRecord[];
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
  /** A signer, or an approver who has no fields. */
  role: RecipientRole;
  /** Set on the signers step only. */
  signatureMeaning?: SignatureMeaning | null;
  /** The step of the signing order; signers who share one sign together. */
  step: number;
};

export type DraftSignerStepData = {
  copyRecipients: readonly CopyRecipientRecord[];
  envelopeId: string;
  /** The most signers this install allows on one envelope. */
  maxSigners: number;
  /** Part 11 mode is on, so each signer needs a meaning and an account. */
  part11Mode?: boolean;
  signers: readonly DraftSignerStepSigner[];
  status: EnvelopeRecord["status"];
};

export type PrepareEnvelopeData = {
  envelopeId: string;
  fields: readonly FieldRecord[];
  /** Sent back with each save, so a save from an older page is refused. */
  fieldsRevision: number;
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
  /** An approver's "signed" is an approval and "declined" a rejection. */
  role: RecipientRole;
  status: "declined" | "pending" | "signed" | "waiting";
  statusDateLabel?: string;
  /** The step of the signing order; signers who share one sign together. */
  step: number;
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

export type EnvelopeDetailDeadline = {
  /** True once the deadline has passed and nobody can sign any more. */
  expired: boolean;
  /** Null for an envelope sent before deadlines existed. */
  expiresAtLabel: string | null;
};

export type EnvelopeDetailData = {
  /** People who get a copy of the finished document without signing. */
  copyRecipients: readonly CopyRecipientRecord[];
  createdAtLabel: string;
  /** Set while the envelope is out for signature. */
  deadline: EnvelopeDetailDeadline | null;
  /** Days between automatic reminders while it is out. Null when off. */
  reminderIntervalDays: number | null;
  envelopeId: string;
  manualReminder: EnvelopeDetailManualReminderState | null;
  /** Sent in Part 11 mode: a void needs a reason. */
  part11: boolean;
  /**
   * How signers sign, when not with SignuDoc's own simple signature: for
   * example "Qualified electronic signatures through eID Easy".
   */
  signatureTypeLabel: string | null;
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

/**
 * Copy recipients are stored after every signer. Signers use 1 up to
 * MAX_SIGNERS_CEILING (100), and a rewrite of the signer list parks rows
 * 1000 higher for a moment.
 */
const COPY_RECIPIENT_SIGN_ORDER_BASE = 500;

export class EnvelopeMutationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "EnvelopeMutationError";
    this.statusCode = statusCode;
  }
}

/**
 * The email service for an action that emails signers (sending or voiding).
 * With no provider connected, the action is refused with a message that says
 * so, before anything changes, instead of failing as an unexpected server
 * error (issues #53, #225).
 */
function createEmailServiceForSending(): EmailService {
  try {
    return createEmailService();
  } catch (error) {
    if (isEmailNotConnectedError(error)) {
      throw new EnvelopeMutationError(EMAIL_NOT_CONNECTED_MESSAGE, 503);
    }

    throw error;
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
export type CopyEnvelopeToDraftResult = CopyEnvelopeResponse;
export type CorrectSentSignerResult = CorrectSentSignerResponse;

const FIELD_TYPE_SUMMARY_LABELS: Record<
  FieldRecord["type"],
  ReviewFieldSummary
> = {
  checkbox: "Checkbox",
  date: "Date",
  dropdown: "Dropdown",
  initials: "Initials",
  name: "Name",
  number: "Number",
  radio: "Radio group",
  signature: "Signature",
  text: "Text",
};

const FIELD_TYPE_SORT_ORDER: Record<FieldRecord["type"], number> = {
  checkbox: 7,
  date: 2,
  dropdown: 6,
  initials: 1,
  name: 3,
  number: 5,
  radio: 8,
  signature: 0,
  text: 4,
};

const TIMELINE_TONE_MAP: Record<
  AuditEventRecord["event"],
  EnvelopeDetailTimelineItem["tone"]
> = {
  approved: "success",
  completed: "success",
  rejected: "danger",
  consented: "neutral",
  copied: "accent",
  created: "accent",
  deadline_changed: "neutral",
  declined: "danger",
  email_sent: "neutral",
  expired: "danger",
  reauthentication_failed: "danger",
  reminded_auto: "neutral",
  signer_corrected: "neutral",
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
  {
    database = getDb(),
    storageService = createStorageService(),
  }: CreateDraftEnvelopeOptions = {},
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
      if (input.folderId !== undefined) {
        await requireWritableFolder(userId, input.folderId, tx);
      }
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
            updated_at,
            folder_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
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
          input.folderId ?? null,
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

type CopyEnvelopeToDraftOptions = {
  actorEmail?: string | null;
  database?: DbPool;
  storageService?: StorageService;
};

/**
 * Starts a new draft from an envelope that has already gone out: the
 * unsigned document, the people who were asked to sign, anyone who was
 * to receive a copy, and where the fields are. Nothing that was filled
 * in comes along. Access codes are hashed, so they cannot be copied.
 * The original envelope is left as it is, and nobody is emailed.
 */
export async function copyEnvelopeToDraft(
  userId: string,
  envelopeId: string,
  {
    actorEmail = null,
    database = getDb(),
    storageService = createStorageService(),
  }: CopyEnvelopeToDraftOptions = {},
): Promise<CopyEnvelopeToDraftResult> {
  const sourceEnvelopeId = idSchema.parse(envelopeId);
  const envelope = await getEnvelopeByIdForUser(
    userId,
    sourceEnvelopeId,
    database,
  );

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.status === "draft") {
    throw new EnvelopeMutationError("Draft envelopes cannot be copied.", 409);
  }

  let sourcePdf: Uint8Array;

  try {
    sourcePdf = (await storageService.getObject(envelope.sourcePdfKey)).body;
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new EnvelopeMutationError(
        "This envelope's document is no longer available, so it cannot be copied.",
        409,
      );
    }

    throw error;
  }

  const newEnvelopeId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const sourcePdfKey = buildEnvelopeOriginalPdfKey({
    envelopeId: newEnvelopeId,
    userId,
  });

  await storageService.putObject({
    body: sourcePdf,
    contentType: "application/pdf",
    key: sourcePdfKey,
  });

  try {
    await withTransaction(async (tx) => {
      // Account closure locks the account before its envelopes.
      await tx.query('SELECT id FROM public."user" WHERE id = $1 FOR SHARE', [
        userId,
      ]);
      // Hold the source until this copy is stored. Without that lock a
      // retention sweep can delete the envelope after this read and before
      // its pages, recipients, and fields are read, and those empty lists
      // would be stored as an incomplete draft.
      //
      // The lock an UPDATE takes, not FOR UPDATE: a signer opening the
      // original needs a share of this row for their audit event.
      const source = await getEnvelopeByIdForUser(
        userId,
        sourceEnvelopeId,
        tx,
        { lock: true },
      );

      if (!source) {
        throw new EnvelopeMutationError("Envelope not found.", 404);
      }

      if (source.status === "draft") {
        throw new EnvelopeMutationError(
          "Draft envelopes cannot be copied.",
          409,
        );
      }

      const placement = await queryOne<{ folderId: string | null }>(
        tx,
        'SELECT folder_id AS "folderId" FROM envelopes WHERE id = $1',
        [sourceEnvelopeId],
      );
      const folderId = placement?.folderId ?? null;
      if (folderId !== null) {
        await requireWritableFolder(userId, folderId, tx);
      }
      const pages = await listEnvelopePagesForEnvelopeId(sourceEnvelopeId, tx);
      const signers = await listSignersForEnvelopeId(sourceEnvelopeId, tx);
      const copyRecipients = await listCopyRecipientsForEnvelopeId(
        sourceEnvelopeId,
        tx,
      );
      const fieldsByEnvelope = await listFieldsForEnvelopeIds(
        [sourceEnvelopeId],
        tx,
      );
      const checks = await listSignerCheckSettings(sourceEnvelopeId, tx);
      const fields = fieldsByEnvelope.get(sourceEnvelopeId) ?? [];
      const signerIdBySourceId = new Map(
        signers.map((signer) => [signer.id, randomUUID()] as const),
      );

      for (const field of fields) {
        if (!signerIdBySourceId.has(field.signerId)) {
          throw new EnvelopeMutationError(
            "This envelope cannot be copied.",
            409,
          );
        }
      }

      const copied = envelopeRecordSchema.parse({
        completedAt: null,
        createdAt: now,
        declinedAt: null,
        evidenceKey: null,
        id: newEnvelopeId,
        pageCount: source.pageCount,
        sentAt: null,
        signedPdfKey: null,
        sourcePdfFilename: source.sourcePdfFilename,
        sourcePdfHash: source.sourcePdfHash,
        sourcePdfKey,
        sourcePdfSizeBytes: sourcePdf.length,
        status: "draft",
        title: source.title,
        updatedAt: now,
        userId,
        voidedAt: null,
      });

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
            updated_at,
            folder_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
          )
        `,
        [
          copied.id,
          copied.userId,
          copied.title,
          copied.status,
          copied.sourcePdfKey,
          copied.sourcePdfFilename,
          copied.sourcePdfSizeBytes,
          copied.pageCount,
          copied.signedPdfKey,
          copied.evidenceKey,
          copied.sourcePdfHash,
          copied.sentAt,
          copied.completedAt,
          copied.declinedAt,
          copied.voidedAt,
          copied.createdAt,
          copied.updatedAt,
          folderId,
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
            randomUUID(),
            newEnvelopeId,
            page.pageNumber,
            page.widthPt,
            page.heightPt,
          ],
        );
      }

      for (const signer of signers) {
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
              require_email_code,
              signature_meaning,
              signing_step,
              role
            ) VALUES (
              $1, $2, $3, $4, $5, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $6, $7, $8, $9, $10, $11, $12
            )
          `,
          [
            signerIdBySourceId.get(signer.id),
            newEnvelopeId,
            signer.name,
            signer.email,
            signer.signOrder,
            now,
            now,
            null,
            checks.get(signer.id)?.requireEmailCode ?? false,
            null,
            signingStepOf(signer),
            // An approver stays an approver in the copy.
            signer.role ?? "signer",
          ],
        );
      }

      for (const [index, recipient] of copyRecipients.entries()) {
        await tx.query(
          `
            INSERT INTO signers (
              id, envelope_id, name, email, sign_order, status, role,
              created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 'pending', 'cc', $6, $6)
          `,
          [
            randomUUID(),
            newEnvelopeId,
            recipient.name,
            recipient.email,
            COPY_RECIPIENT_SIGN_ORDER_BASE + index + 1,
            now,
          ],
        );
      }

      for (const [index, field] of fields.entries()) {
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
              updated_at,
              options,
              group_id
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL, NULL, NULL, NULL, $12, $13, $14::jsonb, $15
            )
          `,
          [
            randomUUID(),
            newEnvelopeId,
            signerIdBySourceId.get(field.signerId),
            field.type,
            field.page,
            field.x,
            field.y,
            field.width,
            field.height,
            field.required,
            field.label ?? null,
            now + index,
            now,
            field.type === "dropdown" && field.options !== undefined
              ? JSON.stringify(field.options)
              : null,
            field.groupId ?? null,
          ],
        );
      }

      await recordAuditEvent(
        {
          actorEmail,
          actorType: "sender",
          createdAt: now,
          envelopeId: newEnvelopeId,
          event: "copied",
          metadata: { sourceEnvelopeId },
        },
        tx,
      );
    }, database);
  } catch (error) {
    await storageService.deleteObject(sourcePdfKey).catch(() => undefined);
    throw error;
  }

  return copyEnvelopeResponseSchema.parse({ id: newEnvelopeId });
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
  { lock = false }: { lock?: boolean } = {},
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
        expires_at AS "expiresAt",
        reminder_interval_days AS "reminderIntervalDays",
        part11,
        signature_level AS "signatureLevel",
        signature_provider AS "signatureProvider",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM envelopes
      WHERE id = $1 AND user_id = $2
      ${lock ? "FOR NO KEY UPDATE" : ""}
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
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM signers
      WHERE envelope_id IN (${placeholders})
        -- Everyone in the signing order: signers and approvers.
        AND role IN ('signer', 'approver')
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

/**
 * The people who get a copy of the finished document without signing. They
 * are rows of the signers table with role 'cc', which every other query
 * here leaves out.
 */
export async function listCopyRecipientsForEnvelopeIds(
  envelopeIds: readonly string[],
  database: DbExecutor,
): Promise<Map<string, CopyRecipientRecord[]>> {
  const recipientsByEnvelope = new Map<string, CopyRecipientRecord[]>();

  if (envelopeIds.length === 0) {
    return recipientsByEnvelope;
  }

  const rows = await queryMany<CopyRecipientRecord & { envelopeId: string }>(
    database,
    `
      SELECT id, envelope_id AS "envelopeId", name, email
      FROM signers
      WHERE envelope_id IN (${buildInClausePlaceholders(envelopeIds.length)})
        AND role = 'cc'
      ORDER BY envelope_id ASC, sign_order ASC, id ASC
    `,
    envelopeIds,
  );

  for (const { envelopeId, ...recipient } of rows) {
    const existing = recipientsByEnvelope.get(envelopeId);

    if (existing) {
      existing.push(recipient);
    } else {
      recipientsByEnvelope.set(envelopeId, [recipient]);
    }
  }

  return recipientsByEnvelope;
}

export async function listCopyRecipientsForEnvelopeId(
  envelopeId: string,
  database: DbExecutor,
): Promise<CopyRecipientRecord[]> {
  return (
    (await listCopyRecipientsForEnvelopeIds([envelopeId], database)).get(
      envelopeId,
    ) ?? []
  );
}

async function listSignerCheckSettings(
  envelopeId: string,
  database: DbExecutor,
): Promise<
  Map<
    string,
    {
      hasAccessCode: boolean;
      requireEmailCode: boolean;
      signatureMeaning: SignatureMeaning | null;
    }
  >
> {
  const rows = await queryMany<{
    hasAccessCode: boolean;
    id: string;
    requireEmailCode: boolean;
    signatureMeaning: string | null;
  }>(
    database,
    `
      SELECT
        id,
        access_code_hash IS NOT NULL AS "hasAccessCode",
        require_email_code AS "requireEmailCode",
        signature_meaning AS "signatureMeaning"
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
        signatureMeaning: parseSignatureMeaning(row.signatureMeaning),
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
        options,
        group_id AS "groupId",
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
    // Everyone whose turn it is: one signer, or all of a step that signs
    // at the same time.
    const waiting = signers.filter((signer) => signer.status === "notified");
    const currentSigners =
      waiting.length > 0
        ? waiting
        : signers.filter((signer) => signer.status === "pending").slice(0, 1);
    const waitingOn =
      currentSigners.length > 0
        ? currentSigners.map((signer) => signer.email).join(", ")
        : "—";

    if (isEnvelopeExpired(envelope, Math.floor(Date.now() / 1000))) {
      return `Expired ${formatShortDate(envelope.expiresAt!)} · was waiting on: ${waitingOn}`;
    }

    return `Waiting on: ${waitingOn}`;
  }

  if (envelope.status === "declined") {
    const declinedSigner = signers.find(
      (signer) => signer.status === "declined",
    );
    return `${declinedSigner?.role === "approver" ? "Rejected" : "Declined"} by: ${declinedSigner?.email ?? "—"}`;
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
  if (isEnvelopeExpired(envelope, Math.floor(Date.now() / 1000))) {
    return "Expired";
  }

  // With one signer "Sent" says it all. With several, say how many are done.
  if (envelope.status === "sent" && signers.length > 1) {
    const signedCount = signers.filter(
      (signer) => signer.status === "signed",
    ).length;

    // An approval is a turn done, not a signature.
    return `${String(signedCount)} of ${String(signers.length)} ${
      signers.some((signer) => signer.role === "approver") ? "done" : "signed"
    }`;
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

/**
 * What is unfinished about a dropdown or a radio group, in words for the
 * sender, or null when every one of them can be answered.
 */
function describeChoiceProblem(
  signers: readonly PersistedSignerRecord[],
  fields: readonly FieldRecord[],
): string | null {
  const problem = findChoiceFieldProblem(fields);

  if (!problem) {
    return null;
  }

  return describeChoiceFieldProblem(
    problem,
    signers.find((signer) => signer.id === problem.signerId)?.name ??
      "a signer",
  );
}

/**
 * A dropdown whose box is too small to show one of its choices at a
 * readable size, in words for the sender, or null. A signer cannot shorten
 * a choice, so a choice that does not fit is drawn as small as it takes,
 * and on the signed document that can be too small to read. The sender
 * fixes it before sending instead.
 */
export async function findUnreadableDropdown(
  signers: ReadonlyArray<{ id: string; name: string }>,
  fields: ReadonlyArray<
    Pick<
      FieldRecord,
      "height" | "options" | "page" | "signerId" | "type" | "width" | "x" | "y"
    >
  >,
  pages: Parameters<typeof findTypedValueTooLongForField>[1],
): Promise<string | null> {
  for (const field of fields) {
    if (field.type !== "dropdown" || !field.options?.length) {
      continue;
    }

    const tooLong = await findTypedValueTooLongForField(
      field.options.map((option) => ({ field, value: option })),
      pages,
    );

    if (tooLong) {
      const signerName =
        signers.find((signer) => signer.id === field.signerId)?.name ??
        "a signer";

      return `A dropdown for ${signerName} on page ${String(tooLong.page)} is too small to show its choices at a readable size. Make the box bigger or the choices shorter.`;
    }
  }

  return null;
}

/** The fields with each group of radio buttons counted once. */
function withRadioGroupsOnce(fields: readonly FieldRecord[]): FieldRecord[] {
  const seenGroups = new Set<string>();

  return fields.filter((field) => {
    if (field.type !== "radio" || !field.groupId) {
      return true;
    }

    if (seenGroups.has(field.groupId)) {
      return false;
    }

    seenGroups.add(field.groupId);

    return true;
  });
}

function getMissingSignatureSigner(
  signers: readonly PersistedSignerRecord[],
  fieldsBySigner: ReadonlyMap<string, readonly FieldRecord[]>,
): PersistedSignerRecord | undefined {
  return signers.find(
    (signer) =>
      signer.role !== "approver" &&
      !(fieldsBySigner.get(signer.id) ?? []).some(
        (field) => field.type === "signature",
      ),
  );
}

/**
 * Approvers are not offered in Part 11 mode. An approval there would be an
 * electronic signature under 21 CFR 11 (11.50 lists approval as a meaning),
 * with the account, password and manifestation that go with one, and the
 * Part 11 validation (docs/part11) covers signers only.
 */
const PART11_APPROVER_MESSAGE =
  "Part 11 mode has no approvers. Make each approver a signer with the meaning Approval, so they sign with their account and password.";

/**
 * What stops the signing order from going out, about signers and
 * approvers, in words for the sender: someone has to sign, every signer
 * needs a Signature field, and an approver has no fields at all.
 */
function describeSigningOrderProblem(
  signers: readonly PersistedSignerRecord[],
  fieldsBySigner: ReadonlyMap<string, readonly FieldRecord[]>,
): string | null {
  if (!signers.some((signer) => signer.role !== "approver")) {
    return "Add at least one signer. Approvers approve or reject, so someone else has to sign.";
  }

  const approverWithFields = signers.find(
    (signer) =>
      signer.role === "approver" &&
      (fieldsBySigner.get(signer.id) ?? []).length > 0,
  );

  if (approverWithFields) {
    return `${approverWithFields.name} is an approver, and approvers have no fields. Remove their fields, or make them a signer.`;
  }

  const missingSignatureSigner = getMissingSignatureSigner(
    signers,
    fieldsBySigner,
  );

  return missingSignatureSigner
    ? `Every signer must have at least one Signature field before sending. ${missingSignatureSigner.name} is missing one.`
    : null;
}

function buildVoidNotificationEmail(input: {
  branding: Branding;
  envelopeId: string;
  envelopeTitle: string;
  senderName: string;
  signerEmail: string;
  signerName: string;
  /** The signer had already signed, so the document they signed won't be completed. */
  signerSigned?: boolean;
}) {
  const subject = `"${input.envelopeTitle}" was voided by ${input.senderName}`;
  const outcome = input.signerSigned
    ? "The signing process has been canceled, so the document you signed will not be completed. No further action is needed."
    : "The signing process has been canceled. No further action is needed.";
  const textBody = [
    `Hi ${input.signerName},`,
    "",
    `${input.senderName} voided "${input.envelopeTitle}" in ${input.branding.productName}.`,
    outcome,
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.signerName)},</p>`,
    `<p>${escapeHtml(input.senderName)} voided &ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; in ${escapeHtml(input.branding.productName)}.</p>`,
    `<p>${escapeHtml(outcome)}</p>`,
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

const SIGNATURE_LEVEL_NAMES = {
  advanced: "advanced electronic signature",
  qualified: "qualified electronic signature",
} as const;

function providerName(id: string | null | undefined): string | null {
  if (!id) {
    return null;
  }

  return (
    signingProviderById(id as SigningProviderId)?.name ??
    (id === "eideasy" ? "eID Easy" : id)
  );
}

function describeSignatureType(envelope: EnvelopeRecord): string | null {
  const level = envelope.signatureLevel;

  if (!level || level === "simple") {
    return null;
  }

  const name = SIGNATURE_LEVEL_NAMES[level];
  const through = providerName(envelope.signatureProvider);

  return `${name[0]!.toUpperCase()}${name.slice(1)}s${through ? ` through ${through}` : ""}`;
}

/** "with a qualified electronic signature through eID Easy", or null. */
function describeProviderSignature(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }

  const signature = (metadata as { providerSignature?: unknown })
    .providerSignature;

  if (typeof signature !== "object" || signature === null) {
    return null;
  }

  const { level, provider } = signature as {
    level?: unknown;
    provider?: unknown;
  };

  if (level !== "advanced" && level !== "qualified") {
    return null;
  }

  return `with ${level === "advanced" ? "an" : "a"} ${SIGNATURE_LEVEL_NAMES[level]}${
    typeof provider === "string" ? ` through ${provider}` : ""
  }`;
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
    case "copied":
      return "Copied from an earlier envelope";
    case "created":
      return "Envelope created";
    case "sent": {
      // A first step of several signers names them all.
      const stepSigners = Array.isArray(event.metadata?.stepSigners)
        ? event.metadata.stepSigners.flatMap((entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            "signerName" in entry &&
            typeof entry.signerName === "string"
              ? [entry.signerName]
              : [],
          )
        : [];

      return stepSigners.length > 1
        ? `Sent to ${joinNames(stepSigners)} to sign at the same time`
        : `Sent to ${targetLabel}`;
    }
    case "viewed":
      return `Viewed by ${targetLabel}`;
    case "signed":
      return typeof event.metadata?.part11 === "object" &&
        event.metadata.part11 !== null &&
        "meaning" in event.metadata.part11 &&
        typeof event.metadata.part11.meaning === "string"
        ? `Signed by ${targetLabel} (${signatureMeaningLabel(parseSignatureMeaning(event.metadata.part11.meaning)) ?? event.metadata.part11.meaning}, password given again)`
        : describeProviderSignature(event.metadata)
          ? `Signed by ${targetLabel} ${describeProviderSignature(event.metadata)!}`
          : `Signed by ${targetLabel}`;
    case "declined":
      return declineReason
        ? `Declined by ${targetLabel} — ${declineReason}`
        : `Declined by ${targetLabel}`;
    case "approved":
      return `Approved by ${targetLabel}`;
    case "rejected":
      return declineReason
        ? `Rejected by ${targetLabel} — ${declineReason}`
        : `Rejected by ${targetLabel}`;
    case "reminded_manual":
      return `Manual reminder sent to ${targetLabel}`;
    case "reminded_auto":
      return `Automatic reminder sent to ${targetLabel}`;
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
      return declineReason
        ? `Envelope voided by sender — ${declineReason}`
        : "Envelope voided by sender";
    case "reauthentication_failed":
      return `Wrong password given while signing for ${targetLabel}`;
    case "deadline_changed":
      return typeof event.metadata?.expiresAt === "number"
        ? `Deadline set to ${formatDeadline(event.metadata.expiresAt)}`
        : "Deadline changed";
    case "expired":
      return "Deadline passed before everyone signed";
    case "signer_corrected":
      return describeSignerCorrectedEvent(event.metadata);
    default:
      return event.event;
  }
}

function buildDetailSignerStatusLabel(
  envelope: EnvelopeRecord,
  signer: PersistedSignerRecord,
  previousSignerName?: string,
): string | undefined {
  const approver = signer.role === "approver";

  if (signer.status === "signed" && signer.signedAt) {
    return `${approver ? "Approved" : "Signed"} ${formatShortDate(signer.signedAt)}`;
  }

  if (signer.status === "declined" && signer.declinedAt) {
    return `${approver ? "Rejected" : "Declined"} ${formatShortDate(signer.declinedAt)}`;
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
  const approver = signer.role === "approver";

  if (envelope.status === "voided" && signer.status === "notified") {
    return approver
      ? "Last notified approver before void"
      : "Last notified signer before void";
  }

  if (signer.status === "declined" && signer.declineReason) {
    return `${approver ? "Rejection" : "Decline"} reason: ${signer.declineReason}`;
  }

  // An approver has no fields to count.
  if (approver) {
    if (envelope.status === "declined" && signer.status === "pending") {
      return "Skipped after decline";
    }

    if (envelope.status === "voided" && signer.status === "pending") {
      return "Not reached before void";
    }

    if (signer.status === "signed") {
      return "Approved";
    }

    if (signer.status === "declined") {
      return "Rejected";
    }

    return signer.status === "notified" ? "Current approver" : "Approver";
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

/** One page of a dashboard list, newest first. */
export type DashboardEnvelopePage = {
  envelopes: DashboardEnvelopeListItem[];
  /** There are older envelopes on the next page. */
  hasMore: boolean;
};

export async function listEnvelopesForUser(
  userId: string,
  filters: Partial<EnvelopeListFilters> = {},
  database: DbExecutor = getDb(),
): Promise<DashboardEnvelopePage> {
  return listEnvelopes(userId, "mine", filters, database);
}

export async function listTeamEnvelopesForUser(
  userId: string,
  filters: Partial<EnvelopeListFilters> = {},
  database: DbExecutor = getDb(),
): Promise<DashboardEnvelopePage> {
  return listEnvelopes(userId, "team", filters, database);
}

/**
 * Agreements in one accessible folder before search or pagination.
 * Other senders' drafts stay private.
 */
export async function listFolderEnvelopesForUser(
  userId: string,
  folderId: string,
  filters: Partial<EnvelopeListFilters> = {},
  database: DbExecutor = getDb(),
): Promise<DashboardEnvelopePage> {
  return listEnvelopes(userId, { folderId }, filters, database);
}

/**
 * Every envelope in the install, whoever sent it, each with its sender.
 * Other members' drafts are left out: a draft is its sender's own until it
 * is sent. For an administrator: the caller checks the role.
 */
export async function listAllEnvelopesForAdmin(
  adminUserId: string,
  filters: Partial<EnvelopeListFilters> = {},
  database: DbExecutor = getDb(),
): Promise<DashboardEnvelopePage> {
  return listEnvelopes(adminUserId, "all", filters, database);
}

type EnvelopeListScope = "all" | "mine" | "team" | { folderId: string };

async function listEnvelopes(
  viewerUserId: string,
  scope: EnvelopeListScope,
  filters: Partial<EnvelopeListFilters>,
  database: DbExecutor,
): Promise<DashboardEnvelopePage> {
  const parsedFilters = envelopeListFiltersSchema.parse(filters);
  // Lists of other people's envelopes name and search each sender.
  const showsSenders = scope !== "mine";
  const values: unknown[] = [viewerUserId];
  const visibleStatus = "(status <> 'draft' OR user_id = $1)";
  let clauses: string[];
  if (typeof scope === "object") {
    values.push(scope.folderId);
    clauses = [
      "folder_id = $2",
      visibleStatus,
      canAccessEnvelopeFolderCondition("$1"),
    ];
  } else if (scope === "mine") {
    clauses = ["user_id = $1", canAccessEnvelopeFolderCondition("$1")];
  } else if (scope === "team") {
    clauses = [
      "folder_id IS NULL",
      `(user_id = $1 OR (status <> 'draft' AND ${sharesTeamCondition("$1")}))`,
    ];
  } else {
    clauses = [
      visibleStatus,
      `EXISTS (SELECT 1 FROM public."user" WHERE id = $1 AND role = 'admin')`,
    ];
  }
  let nextParamIndex = values.length + 1;

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
        )${
          // Across a team or the install, the sender too.
          showsSenders
            ? `
        OR EXISTS (
          SELECT 1
          FROM public."user" sender
          WHERE sender.id = envelopes.user_id
            AND (
              lower(sender.email) LIKE ${searchPlaceholder} ESCAPE '\\'
              OR lower(sender.name) LIKE ${searchPlaceholder} ESCAPE '\\'
            )
        )`
            : ""
        }
      )`,
    );
    values.push(`%${escapeLike(parsedFilters.search.toLowerCase())}%`);
    nextParamIndex += 1;
  }

  const limitPlaceholder = `$${String(nextParamIndex)}`;
  // One more than a page, to tell whether there is a next one.
  values.push(parsedFilters.limit + 1);
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
        expires_at AS "expiresAt",
        reminder_interval_days AS "reminderIntervalDays",
        part11,
        signature_level AS "signatureLevel",
        signature_provider AS "signatureProvider",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM envelopes
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `,
    values,
  );

  const hasMore = rows.length > parsedFilters.limit;
  const envelopes = rows.slice(0, parsedFilters.limit).map(mapEnvelopeRow);
  const envelopeIds = envelopes.map((envelope) => envelope.id);
  const [signersByEnvelope, fieldsByEnvelope, copyRecipientsByEnvelope] =
    await Promise.all([
      listSignersForEnvelopeIds(envelopeIds, database),
      listFieldsForEnvelopeIds(envelopeIds, database),
      listCopyRecipientsForEnvelopeIds(envelopeIds, database),
    ]);
  const sendersById = showsSenders
    ? await listSendersById(
        envelopes.map((envelope) => envelope.userId),
        database,
      )
    : null;

  const items = envelopes.map((envelope) => {
    const signers = signersByEnvelope.get(envelope.id) ?? [];
    const fields = fieldsByEnvelope.get(envelope.id) ?? [];
    const sender = sendersById?.get(envelope.userId);

    return {
      ...(sendersById
        ? {
            senderLabel: sender
              ? formatEnvelopeOwner({
                  ownerEmail: sender.email,
                  ownerName: sender.name,
                })
              : "Unknown sender",
          }
        : {}),
      contextLine: buildDashboardContextLine(envelope, signers, fields),
      createdAtLabel: formatShortDate(envelope.createdAt),
      expired: isEnvelopeExpired(envelope, Math.floor(Date.now() / 1000)),
      id: envelope.id,
      // The search on the server matches copy recipients too.
      searchableEmails: [
        ...signers,
        ...(copyRecipientsByEnvelope.get(envelope.id) ?? []),
        // Across a team or the install, the sender too.
        ...(sender ? [sender] : []),
      ].map((recipient) => recipient.email),
      status: envelope.status,
      statusLabel: buildDashboardStatusLabel(envelope, signers),
      title: envelope.title,
    };
  });

  return { envelopes: items, hasMore };
}

type SenderRow = { email: string; id: string; name: string | null };

async function listSendersById(
  userIds: readonly string[],
  database: DbExecutor,
): Promise<Map<string, SenderRow>> {
  const uniqueIds = [...new Set(userIds)];

  if (uniqueIds.length === 0) {
    return new Map();
  }

  const rows = await queryMany<SenderRow>(
    database,
    `SELECT id, name, email FROM public."user" WHERE id = ANY($1::text[])`,
    [uniqueIds],
  );

  return new Map(rows.map((row) => [row.id, row]));
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

  const [signersByEnvelope, fieldsByEnvelope, auditEvents, copyRecipients] =
    await Promise.all([
      listSignersForEnvelopeIds([envelopeId], database),
      listFieldsForEnvelopeIds([envelopeId], database),
      listAuditEventsForEnvelope(envelopeId, database),
      listCopyRecipientsForEnvelopeId(envelopeId, database),
    ]);
  const signers = signersByEnvelope.get(envelopeId) ?? [];
  const fields = fieldsByEnvelope.get(envelopeId) ?? [];
  const fieldCountsBySigner = new Map(
    [...buildFieldsBySigner(fields)].map(
      ([signerId, signerFields]) =>
        [
          signerId,
          countAnswerableFields(signerFields, shouldCountFieldForSignerSummary),
        ] as const,
    ),
  );
  const timeline = auditEvents.map((event) => ({
    description: buildTimelineDescription(event),
    id: event.id,
    timestamp: formatTimelineTimestamp(event.createdAt),
    tone: TIMELINE_TONE_MAP[event.event],
  }));

  const signerViews = signers.map((signer) => {
    const step = signingStepOf(signer);
    // Whoever signs in the step just before this signer's.
    const previousStep = signers
      .map(signingStepOf)
      .filter((other) => other < step)
      .reduce<number | null>(
        (latest, other) => (latest === null || other > latest ? other : latest),
        null,
      );
    const previousSignerName =
      previousStep === null
        ? undefined
        : joinNames(
            signers
              .filter((other) => signingStepOf(other) === previousStep)
              .map((other) => other.name),
          );
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
      role: signer.role ?? "signer",
      status: signerStatus,
      statusDateLabel: buildDetailSignerStatusLabel(
        envelope,
        signer,
        previousSignerName,
      ),
      step,
    };
  });
  // Everyone whose turn it is. A reminder goes to each of them whose last
  // one is far enough back (reminders.ts), so the button works while any of
  // them can have one.
  const waitingSigners = signers.filter(
    (signer) => signer.status === "notified",
  );
  let manualReminder: EnvelopeDetailManualReminderState | null = null;

  const nowUnixTimestamp = Math.floor(Date.now() / 1000);
  const expired = isEnvelopeExpired(envelope, nowUnixTimestamp);

  if (envelope.status === "sent" && waitingSigners.length > 0 && expired) {
    // A reminder would carry a link that no longer works.
    manualReminder = { canSend: false, nextAvailableAtLabel: null };
  } else if (envelope.status === "sent" && waitingSigners.length > 0) {
    const canSend = waitingSigners.some((signer) =>
      isManualNudgeAvailable(signer.lastNudgedAt, nowUnixTimestamp),
    );
    const nextAvailableAt = waitingSigners
      .map((signer) =>
        typeof signer.lastNudgedAt === "number"
          ? getManualNudgeAvailableAt(signer.lastNudgedAt)
          : null,
      )
      .reduce<number | null>(
        (earliest, at) =>
          at !== null && (earliest === null || at < earliest) ? at : earliest,
        null,
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
    copyRecipients,
    createdAtLabel: formatLongDate(envelope.createdAt),
    deadline:
      envelope.status === "sent"
        ? {
            expired,
            expiresAtLabel:
              typeof envelope.expiresAt === "number"
                ? formatDeadline(envelope.expiresAt)
                : null,
          }
        : null,
    envelopeId,
    reminderIntervalDays:
      envelope.status === "sent"
        ? (envelope.reminderIntervalDays ?? null)
        : null,
    manualReminder,
    part11: Boolean(envelope.part11),
    signatureTypeLabel: describeSignatureType(envelope),
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
    copyRecipients: await listCopyRecipientsForEnvelopeId(envelopeId, database),
    envelopeId,
    maxSigners: getMaxSignersPerEnvelope(),
    part11Mode: (await readStoredSettings(database))?.part11Mode ?? false,
    signers: (await listSignersForEnvelopeId(envelopeId, database)).map(
      (signer) => ({
        email: signer.email,
        hasAccessCode: checks.get(signer.id)?.hasAccessCode ?? false,
        id: signer.id,
        name: signer.name,
        order: signer.signOrder,
        requireEmailCode: checks.get(signer.id)?.requireEmailCode ?? false,
        role: signer.role ?? "signer",
        signatureMeaning: checks.get(signer.id)?.signatureMeaning ?? null,
        step: signingStepOf(signer),
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
    storageService = createStorageService(),
  }: {
    database?: DbExecutor;
    storageService?: StorageService;
  } = {},
): Promise<DraftEnvelopeDocument> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeDocumentAccessError("Envelope not found.", 404);
  }

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
 *
 * An envelope keeps the first picture it is given. Its document never
 * changes, so there is nothing a later picture could show that the first
 * does not, and a browser is told its copy is still good by the envelope
 * alone (buildThumbnailEtag), which only holds while the picture stays the
 * same.
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
    keepExisting: true,
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

export type EnvelopeThumbnail =
  | { etag: string; isNotModified: true }
  | { etag: string; isNotModified: false; picture: StorageObjectStream };

/**
 * Streams the stored first-page picture, or says there is none (404).
 *
 * A browser that already holds the picture sends the name it was given
 * (`ifNoneMatch`). The account is checked first, as always, and then the
 * answer is "your copy is still good" without a read from file storage.
 */
export async function getEnvelopeThumbnailForUser(
  userId: string,
  envelopeId: string,
  {
    database = getDb(),
    ifNoneMatch,
    storageService = createStorageService(),
  }: {
    database?: DbExecutor;
    ifNoneMatch?: string | null;
    storageService?: StorageService;
  } = {},
): Promise<EnvelopeThumbnail> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeDocumentAccessError("Envelope not found.", 404);
  }

  const etag = buildThumbnailEtag(envelope.id);

  if (matchesEtag(ifNoneMatch, etag)) {
    return { etag, isNotModified: true };
  }

  try {
    const picture = await storageService.getObjectStream(
      buildEnvelopeThumbnailKey({
        envelopeId: envelope.id,
        sourcePdfKey: envelope.sourcePdfKey,
        userId,
      }),
    );

    return { etag, isNotModified: false, picture };
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

  // Read before the fields, so a save landing in between pairs the newer
  // fields with the older revision: the editor's first save is then
  // refused and it asks for a reload, rather than an older list being
  // taken as the latest.
  const fieldsRevision = await readFieldsRevision(envelopeId, database);
  const [fieldsByEnvelope, pages, signers] = await Promise.all([
    listFieldsForEnvelopeIds([envelopeId], database),
    listEnvelopePagesForEnvelopeId(envelopeId, database),
    listSignersForEnvelopeId(envelopeId, database),
  ]);

  return {
    envelopeId,
    fields: fieldsByEnvelope.get(envelopeId) ?? [],
    fieldsRevision,
    pageCount: envelope.pageCount,
    pages,
    pdfUrl: `/api/envelopes/${encodeURIComponent(envelopeId)}/document`,
    signers: signers.map((signer) => ({
      email: signer.email,
      id: signer.id,
      name: signer.name,
      order: signer.signOrder,
      role: signer.role ?? "signer",
      step: signingStepOf(signer),
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

  const [signersByEnvelope, fieldsByEnvelope, copyRecipients] =
    await Promise.all([
      listSignersForEnvelopeIds([envelopeId], database),
      listFieldsForEnvelopeIds([envelopeId], database),
      listCopyRecipientsForEnvelopeId(envelopeId, database),
    ]);
  const signers = signersByEnvelope.get(envelopeId) ?? [];
  const fields = fieldsByEnvelope.get(envelopeId) ?? [];
  const fieldsBySigner = buildFieldsBySigner(fields);
  const signingOrderProblem =
    signers.length > 0
      ? describeSigningOrderProblem(signers, fieldsBySigner)
      : null;
  const isEmpty = signers.length === 0 || fields.length === 0;
  const choiceProblem = describeChoiceProblem(signers, fields);
  const provider = configuredSigningProvider();
  const part11Mode = (await readStoredSettings(database))?.part11Mode ?? false;
  const hasApprovers = signers.some((signer) => signer.role === "approver");
  const approverProblem =
    hasApprovers && part11Mode ? PART11_APPROVER_MESSAGE : null;
  const disabledReason =
    signingOrderProblem ?? choiceProblem ?? approverProblem;

  return {
    canSend: !isEmpty && !disabledReason,
    // Approvers approve on SignuDoc's own page, so a signing provider is
    // not offered alongside them (see sendDraftEnvelope).
    signingProvider:
      provider && !part11Mode && !hasApprovers ? { name: provider.name } : null,
    copyRecipients,
    disabledReason,
    envelopeId,
    filename: envelope.sourcePdfFilename,
    isEmpty,
    pageCount: envelope.pageCount,
    signers: signers.map((signer) => ({
      email: signer.email,
      fieldSummaries: withRadioGroupsOnce(fieldsBySigner.get(signer.id) ?? [])
        .sort(
          (left, right) =>
            FIELD_TYPE_SORT_ORDER[left.type] -
            FIELD_TYPE_SORT_ORDER[right.type],
        )
        .map((field) => FIELD_TYPE_SUMMARY_LABELS[field.type]),
      id: signer.id,
      name: signer.name,
      order: signer.signOrder,
      role: signer.role ?? "signer",
      step: signingStepOf(signer),
    })),
    sizeLabel: formatFileSize(envelope.sourcePdfSizeBytes),
    status: envelope.status,
    title: envelope.title,
  };
}

/** Everyone on a draft and every field placed for them, in a fixed order. */
async function readDraftParties(envelopeId: string, database: DbExecutor) {
  const signers = await listSignersForEnvelopeId(envelopeId, database);
  const fields =
    (await listFieldsForEnvelopeIds([envelopeId], database)).get(envelopeId) ??
    [];
  const copyRecipients = await listCopyRecipientsForEnvelopeId(
    envelopeId,
    database,
  );

  return { copyRecipients, fields, signers };
}

function recipientKey(recipient: ExpectedRecipient): string {
  return JSON.stringify([
    recipient.email.trim().toLowerCase(),
    recipient.name.trim(),
  ]);
}

/**
 * Whether a draft's parties are exactly the confirmed people: the signers
 * in signing order, and the copy recipients in any order.
 */
export function draftRecipientsMatch(
  parties: {
    copyRecipients: readonly ExpectedRecipient[];
    signers: readonly ExpectedRecipient[];
  },
  expected: {
    copyRecipients: readonly ExpectedRecipient[];
    signers: readonly ExpectedRecipient[];
  },
): boolean {
  const sameInOrder = (
    left: readonly ExpectedRecipient[],
    right: readonly ExpectedRecipient[],
  ) =>
    left.length === right.length &&
    left.every(
      (recipient, index) =>
        recipientKey(recipient) === recipientKey(right[index]!),
    );
  const sorted = (recipients: readonly ExpectedRecipient[]) =>
    [...recipients].sort((left, right) =>
      recipientKey(left).localeCompare(recipientKey(right)),
    );

  return (
    sameInOrder(parties.signers, expected.signers) &&
    sameInOrder(sorted(parties.copyRecipients), sorted(expected.copyRecipients))
  );
}

/**
 * Takes hold of a draft before its signers or fields are changed, and
 * refuses when it is no longer a draft. Saving signers, saving fields,
 * sending, and erasing a signer on request all take the envelope's row
 * first, so they happen one after the other: a save cannot land on an
 * envelope that was sent a moment before, and a send cannot go out with
 * signers or fields that a save or an erasure was just then replacing.
 *
 * The lock an UPDATE takes, not FOR UPDATE: the signer rows written next
 * need a share of this row for their foreign key.
 */
/** What a sender is told when their field save was made on an older page. */
export const FIELDS_CHANGED_MESSAGE =
  "These fields were changed somewhere else, so this change was not saved. Reload the page to see the latest fields.";

async function readFieldsRevision(
  envelopeId: string,
  database: DbExecutor,
): Promise<number> {
  const result = await database.query<{ fields_revision: number }>(
    `SELECT fields_revision FROM envelopes WHERE id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.fields_revision ?? 0;
}

async function lockDraftEnvelope(
  userId: string,
  envelopeId: string,
  tx: DbExecutor,
): Promise<void> {
  await lockOwnedEnvelopeFolder(userId, envelopeId, tx);
  const locked = await tx.query(
    `
      SELECT id FROM envelopes
      WHERE id = $1 AND user_id = $2 AND status = 'draft'
      FOR NO KEY UPDATE
    `,
    [envelopeId, userId],
  );

  if (locked.rowCount !== 1) {
    throw new EnvelopeMutationError(
      "Only draft envelopes can be updated.",
      409,
    );
  }
}

async function lockOwnedEnvelopeFolder(
  userId: string,
  envelopeId: string,
  tx: DbExecutor,
): Promise<void> {
  // Keep account, agreement, and folder locks in the same order as filing.
  await tx.query('SELECT id FROM public."user" WHERE id = $1 FOR SHARE', [
    userId,
  ]);
  const row = await queryOne<{ folderId: string | null }>(
    tx,
    `SELECT folder_id AS "folderId" FROM envelopes
     WHERE id = $1 AND user_id = $2 FOR NO KEY UPDATE`,
    [envelopeId, userId],
  );
  if (row?.folderId) {
    try {
      await requireWritableFolder(userId, row.folderId, tx);
    } catch (error) {
      if (error instanceof TeamError && error.statusCode === 404) {
        throw new EnvelopeMutationError("Envelope not found.", 404);
      }
      throw error;
    }
  }
}

export async function sendDraftEnvelope(
  userId: string,
  envelopeId: string,
  input: SendDraftEnvelopeInput,
  { database = getDb(), expectedRecipients }: SendDraftEnvelopeOptions = {},
): Promise<SendDraftEnvelopeResult> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.status !== "draft") {
    throw new EnvelopeMutationError("Only draft envelopes can be sent.", 409);
  }

  const checkedParties = await readDraftParties(envelopeId, database);
  const { fields, signers } = checkedParties;

  // The transaction below refuses a draft whose parties changed after this
  // read, so the people checked here are the people the invitation reaches.
  if (
    expectedRecipients &&
    !draftRecipientsMatch(checkedParties, expectedRecipients)
  ) {
    throw new EnvelopeMutationError(draftRecipientsChangedMessage, 409);
  }

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

  const signingOrderProblem = describeSigningOrderProblem(
    signers,
    buildFieldsBySigner(fields),
  );

  if (signingOrderProblem) {
    throw new EnvelopeMutationError(signingOrderProblem, 400);
  }

  const choiceProblem = describeChoiceProblem(signers, fields);

  if (choiceProblem) {
    throw new EnvelopeMutationError(choiceProblem, 400);
  }

  const unreadableDropdown = await findUnreadableDropdown(
    signers,
    fields,
    await listEnvelopePagesForEnvelopeId(envelopeId, database),
  );

  if (unreadableDropdown) {
    throw new EnvelopeMutationError(unreadableDropdown, 400);
  }

  // In Part 11 mode each signer signs with their own verified account, and
  // the envelope keeps that rule even if the mode is turned off later.
  const part11 = (await readStoredSettings(database))?.part11Mode ?? false;

  // Signatures in the signers' own names need the install's signing
  // provider. Part 11 envelopes are signed with the signers' accounts, and
  // the two are not combined.
  const signatureLevel = input.signatureLevel ?? "simple";
  const hasApprovers = signers.some((signer) => signer.role === "approver");

  // Approvers are SignuDoc's own. In Part 11 mode an approval would be an
  // electronic signature with everything Part 11 asks of one, so the
  // approver signs instead (see PART11_APPROVER_MESSAGE). With signatures
  // through a signing provider, the finished document is the last
  // signer's own signed revision, and an approval makes none.
  if (hasApprovers && part11) {
    throw new EnvelopeMutationError(PART11_APPROVER_MESSAGE, 400);
  }

  if (hasApprovers && signatureLevel !== "simple") {
    throw new EnvelopeMutationError(
      "Approvers work with SignuDoc signatures only. Send with simple signatures, or make the approvers signers.",
      400,
    );
  }

  // Signing at the same time is for SignuDoc's own simple signatures.
  //
  // * Part 11 mode keeps one signer after another. Its validation
  //   (docs/part11, SYS-08 and OQ-06) is written for that order, and a
  //   changed sequence would need the install's OQ run again before use.
  // * A signature in the signer's own name is added to the PDF on top of
  //   the one before it, so two cannot be made at once: the second would
  //   be refused once the first was saved, after the signer had already
  //   been through the provider.
  if (hasSharedSigningStep(signers)) {
    if (part11) {
      throw new EnvelopeMutationError(
        "Part 11 mode signs one signer after another. Give each signer their own step in the signing order.",
        400,
      );
    }

    if (signatureLevel !== "simple") {
      throw new EnvelopeMutationError(
        "Advanced and qualified signatures are added one after another. Give each signer their own step, or send with simple signatures.",
        400,
      );
    }
  }

  const signingProvider =
    signatureLevel === "simple" ? null : configuredSigningProvider();

  if (signatureLevel !== "simple") {
    if (!signingProvider) {
      throw new EnvelopeMutationError(
        "This install has no signing provider for advanced or qualified signatures.",
        400,
      );
    }

    if (part11) {
      throw new EnvelopeMutationError(
        "Part 11 mode signs with the signers' accounts. Send with simple signatures.",
        400,
      );
    }
  }

  const delivery = input.delivery ?? "email";

  if (delivery === "embedded") {
    if (part11) {
      throw new EnvelopeMutationError(
        "Part 11 envelopes are signed with the signers' own accounts on this install, so they cannot be embedded in another app.",
        400,
      );
    }

    if (signatureLevel !== "simple") {
      throw new EnvelopeMutationError(
        "Advanced and qualified signatures send the signer to the signing provider, so they cannot be embedded in another app.",
        400,
      );
    }

    if (!(await hasEmbedOrigins(database))) {
      throw new EnvelopeMutationError(
        "Embedded signing is off: no site is allowed to show signing pages. An administrator can add one under Settings, Organization, Embedded signing.",
        400,
      );
    }

    const checks = await listSignerCheckSettings(envelopeId, database);

    if (
      [...checks.values()].some(
        (check) => check.hasAccessCode || check.requireEmailCode,
      )
    ) {
      throw new EnvelopeMutationError(
        "Embedded signers are identified by your app, so leave out access codes and emailed codes.",
        400,
      );
    }
  }

  const part11SignerAccounts = new Map<
    string,
    { name: string; userId: string }
  >();

  if (part11) {
    const checks = await listSignerCheckSettings(envelopeId, database);
    const accounts = await findSignerAccounts(
      signers.map((signer) => signer.email),
      database,
    );

    for (const signer of signers) {
      const account = accounts.get(signer.email.toLowerCase());
      const problem = describePart11SignerProblem(
        {
          email: signer.email,
          name: signer.name,
          signatureMeaning: checks.get(signer.id)?.signatureMeaning ?? null,
        },
        account,
      );

      if (problem || !account) {
        throw new EnvelopeMutationError(
          problem ?? "A signer cannot sign in Part 11 mode.",
          400,
        );
      }

      part11SignerAccounts.set(signer.id, {
        name: account.name,
        userId: account.userId,
      });
    }
  }

  // Everyone in the first step of the signing order is invited now. A
  // Part 11 signer is invited, and recorded as sent to, in the name the
  // administrator confirmed, which is the name saved on the signer below.
  const firstSigners = firstStepSigners(
    signers.map((signer) => {
      const account = part11SignerAccounts.get(signer.id);

      return account ? { ...signer, name: account.name } : signer;
    }),
  );
  const firstSigner = firstSigners[0];

  if (!firstSigner) {
    throw new EnvelopeMutationError(
      "Add signers before sending this envelope.",
      400,
    );
  }

  const emailService = createEmailServiceForSending();
  const storageService = createStorageService();
  const sourcePdfHead = await storageService.headObject(envelope.sourcePdfKey);

  if (!sourcePdfHead.exists) {
    throw new EnvelopeMutationError(
      "The source document for this envelope could not be found.",
      500,
    );
  }

  const sentAt = Math.floor(Date.now() / 1000);
  const expiresAt = deadlineFromDays(sentAt, input.expiresInDays);
  const issuedLinks = new Map<string, IssuedSigningLink>();

  for (const signer of firstSigners) {
    issuedLinks.set(
      signer.id,
      await issueSigningLink({
        expiresInSeconds: expiresAt - sentAt,
        issuedAt: sentAt,
      }),
    );
  }

  try {
    await withTransaction(async (tx) => {
      await lockOwnedEnvelopeFolder(userId, envelopeId, tx);
      const updatedEnvelope = await tx.query(
        `
          UPDATE envelopes
          SET
            status = 'sent',
            sent_at = $1,
            updated_at = $2,
            expires_at = $5,
            expiry_notified_at = NULL,
            reminder_interval_days = $6
          WHERE id = $3
            AND user_id = $4
            AND status = 'draft'
        `,
        [
          sentAt,
          sentAt,
          envelopeId,
          userId,
          expiresAt,
          input.reminderIntervalDays ?? null,
        ],
      );

      if (updatedEnvelope.rowCount !== 1) {
        throw new EnvelopeMutationError(
          "This envelope has already been sent.",
          409,
        );
      }

      // The signers and fields were read and checked before this
      // transaction began. The update above holds the envelope's row,
      // which everything that changes a draft's signers or fields takes
      // first, so what is read here is what goes out. If it is not what
      // was checked (a signer erased on request, a save from another tab),
      // nothing is sent.
      if (
        JSON.stringify(await readDraftParties(envelopeId, tx)) !==
        JSON.stringify(checkedParties)
      ) {
        throw new EnvelopeMutationError(
          "This envelope was changed while it was being sent. Check it and send it again.",
          409,
        );
      }

      // Access codes and emailed codes are not part of that snapshot, and
      // an embedded signer has no way to enter one. Checked again here,
      // under the same lock that a save of the signers takes.
      if (delivery === "embedded") {
        const lockedChecks = await listSignerCheckSettings(envelopeId, tx);

        if (
          [...lockedChecks.values()].some(
            (check) => check.hasAccessCode || check.requireEmailCode,
          )
        ) {
          throw new EnvelopeMutationError(
            "Embedded signers are identified by your app, so leave out access codes and emailed codes.",
            400,
          );
        }
      }

      await tx.query(
        `
          UPDATE signers
          SET
            status = 'pending',
            signing_token_hash = NULL,
            spent_signing_token_hash = NULL,
            signing_token_expires_at = NULL,
            turn_started_at = NULL,
            last_notified_at = NULL,
            last_nudged_at = NULL,
            signed_at = NULL,
            declined_at = NULL,
            decline_reason = NULL,
            user_id = NULL,
            updated_at = $1
          WHERE envelope_id = $2
        `,
        [sentAt, envelopeId],
      );

      if (signingProvider) {
        await tx.query(
          `
            UPDATE envelopes
            SET signature_level = $1, signature_provider = $2
            WHERE id = $3
          `,
          [signatureLevel, signingProvider.id, envelopeId],
        );
      }

      if (delivery === "embedded") {
        await tx.query(
          `UPDATE envelopes SET delivery = 'embedded' WHERE id = $1`,
          [envelopeId],
        );
      }

      if (part11) {
        await tx.query(`UPDATE envelopes SET part11 = true WHERE id = $1`, [
          envelopeId,
        ]);

        // Each signer is bound to their account and named as the
        // administrator confirmed them, so the signature and its audit
        // record carry the confirmed name, not one typed for the draft.
        for (const [signerId, account] of part11SignerAccounts) {
          const bound = await tx.query(
            `
              UPDATE signers
              SET user_id = $1, name = $4
              WHERE id = $2
                AND envelope_id = $3
                AND signature_meaning IS NOT NULL
            `,
            [account.userId, signerId, envelopeId, account.name],
          );

          if (bound.rowCount !== 1) {
            throw new EnvelopeMutationError(
              "This envelope was changed while it was being sent. Check it and send it again.",
              409,
            );
          }
        }
      }

      for (const signer of firstSigners) {
        const issuedLink = issuedLinks.get(signer.id)!;
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
            signer.id,
            envelopeId,
          ],
        );

        if (updatedSigner.rowCount !== 1) {
          throw new EnvelopeMutationError(
            "Unable to activate the first signer for this envelope.",
            500,
          );
        }
      }

      await recordAuditEvent(
        {
          actorEmail: input.senderEmail,
          actorType: "sender",
          // Keep the sent audit timestamp equal to envelopes.sent_at; tied
          // whole-second events (created, sent, email_sent) stay ordered by
          // audit_events.sequence rather than bumping sent past email_sent.
          createdAt: sentAt,
          envelopeId,
          event: "sent",
          ipAddress: input.ipAddress ?? null,
          metadata: {
            ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
            ...(delivery === "embedded" ? { delivery } : {}),
            // The send route refuses a send without this confirmation.
            expiresAt,
            reminderIntervalDays: input.reminderIntervalDays ?? null,
            permittedUseConfirmed: true,
            permittedUseVersion: PERMITTED_USE_VERSION,
            ...(part11 ? { part11: true } : {}),
            ...(signingProvider
              ? {
                  signatureLevel,
                  signingProvider: signingProvider.name,
                }
              : {}),
            signerEmail: firstSigner.email,
            signerId: firstSigner.id,
            signerName: firstSigner.name,
            // Everyone invited, when the first step has more than one.
            ...(firstSigners.length > 1
              ? {
                  stepSigners: firstSigners.map((signer) => ({
                    signerEmail: signer.email,
                    signerId: signer.id,
                    signerName: signer.name,
                  })),
                }
              : {}),
          },
          userAgent: input.userAgent ?? null,
        },
        tx,
      );
    }, database);
  } catch (error) {
    throw error;
  }

  if (delivery === "embedded") {
    // No invitation: the app asks the API for a link for each signer
    // whose turn it is (see embedding.ts). The envelope is out for
    // signature now, so its envelope.sent webhook can go.
    await releaseSentWebhook(envelopeId, database).catch((error: unknown) => {
      console.error(
        `Releasing the envelope.sent webhook of ${envelopeId} failed:`,
        error,
      );
    });

    return sendEnvelopeResponseSchema.parse({
      envelopeId,
      expiresAt,
      notifiedSignerName: describeNotifiedSigners(
        firstSigners.map((signer) => signer.name),
      ),
      redirectPath: `/envelopes/${envelopeId}`,
      sentAt,
    });
  }

  // The first invitation decides whether the envelope went out. If it
  // fails, nothing has been delivered, and the envelope goes back to being
  // a draft. Once one has been accepted the envelope is out: a later one
  // that fails is logged, and the sender's reminder (or the automatic one)
  // sends that signer a new link.
  const invitationMessageIds = new Map<string, string | undefined>();
  let branding: Branding;

  try {
    branding = await getBranding();
    invitationMessageIds.set(
      firstSigner.id,
      (
        await emailService.send(
          buildSigningInvitationEmail({
            branding,
            envelopeTitle: envelope.title,
            expiresAt,
            role: firstSigner.role,
            senderName: input.senderName,
            signerEmail: firstSigner.email,
            signerName: firstSigner.name,
            signingUrl: issuedLinks.get(firstSigner.id)!.url,
          }),
        )
      ).messageId,
    );
  } catch (error) {
    await withTransaction(async (tx) => {
      const revertedEnvelope = await tx.query(
        `
          UPDATE envelopes
          SET
            status = 'draft',
            sent_at = NULL,
            expires_at = NULL,
            reminder_interval_days = NULL,
            part11 = false,
            signature_level = 'simple',
            signature_provider = NULL,
            updated_at = $1
          WHERE id = $2
            AND user_id = $3
            AND status = 'sent'
        `,
        [envelope.updatedAt, envelopeId, userId],
      );

      // Something else ended the envelope after it went out (it was voided,
      // say). Its signers and history are that envelope's now: leave them.
      if (revertedEnvelope.rowCount !== 1) {
        return;
      }

      await tx.query(
        `
          UPDATE signers
          SET
            status = 'pending',
            signing_token_hash = NULL,
            spent_signing_token_hash = NULL,
            signing_token_expires_at = NULL,
            turn_started_at = NULL,
            last_notified_at = NULL,
            last_nudged_at = NULL,
            signed_at = NULL,
            declined_at = NULL,
            decline_reason = NULL,
            user_id = NULL,
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
        [envelopeId, sentAt, input.senderEmail],
      );
      // The envelope.sent webhook was held for the invitation (see
      // releaseSentWebhook below); it did not go out, so there is nothing
      // to tell, whatever happened to the delivery meanwhile.
      await tx.query(
        `
          DELETE FROM webhook_deliveries
          WHERE envelope_id = $1 AND event_type = 'envelope.sent'
            AND status = 'pending'
        `,
        [envelopeId],
      );
    }, database).catch((rollbackError) => {
      console.error(
        `Failed to roll back sent envelope ${envelopeId} after email delivery failure:`,
        rollbackError,
      );
    });

    throw error;
  }

  for (const signer of firstSigners.slice(1)) {
    try {
      invitationMessageIds.set(
        signer.id,
        (
          await emailService.send(
            buildSigningInvitationEmail({
              branding,
              envelopeTitle: envelope.title,
              expiresAt,
              role: signer.role,
              senderName: input.senderName,
              signerEmail: signer.email,
              signerName: signer.name,
              signingUrl: issuedLinks.get(signer.id)!.url,
            }),
          )
        ).messageId,
      );
    } catch (error) {
      console.error(
        `Failed to send the invitation for envelope ${envelopeId} to ${signer.email}:`,
        error,
      );
    }
  }

  for (const signer of firstSigners) {
    if (!invitationMessageIds.has(signer.id)) {
      continue;
    }

    await recordEmailSent(
      {
        envelopeId,
        messageId: invitationMessageIds.get(signer.id),
        recipient: signer.email,
        signerId: signer.id,
        template: "signing_invitation",
      },
      database,
    );
  }

  // Only now that the invitations are out is the envelope really sent.
  await releaseSentWebhook(envelopeId, database).catch((error: unknown) => {
    // Then it goes out when its hold runs out instead.
    console.error(
      `Releasing the envelope.sent webhook of ${envelopeId} failed:`,
      error,
    );
  });

  return sendEnvelopeResponseSchema.parse({
    envelopeId,
    expiresAt,
    // Only those whose invitation went out.
    notifiedSignerName: describeNotifiedSigners(
      firstSigners
        .filter((signer) => invitationMessageIds.has(signer.id))
        .map((signer) => signer.name),
    ),
    redirectPath: `/envelopes/${envelopeId}`,
    sentAt,
  });
}

/** Who was invited, short enough for the message the sender sees. */
function describeNotifiedSigners(names: readonly string[]): string {
  const all = joinNames(names);

  if (all.length <= 160 || names.length < 2) {
    return all.slice(0, 160);
  }

  return `${names[0]!.slice(0, 120)} and ${String(names.length - 1)} others`;
}

type ChangeEnvelopeDeadlineInput = {
  expiresInDays: number;
  ipAddress?: string | null;
  senderEmail: string;
  userAgent?: string | null;
};

/**
 * Gives an envelope that is out for signature a new deadline, counted from
 * now. The current signer's link is kept and simply lives until the new
 * deadline, so a link that had expired works again.
 */
export async function changeEnvelopeDeadline(
  userId: string,
  envelopeId: string,
  input: ChangeEnvelopeDeadlineInput,
  {
    database = getDb(),
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: { database?: DbPool; nowUnixTimestamp?: number } = {},
): Promise<ChangeDeadlineResponse> {
  const expiresAt = deadlineFromDays(nowUnixTimestamp, input.expiresInDays);

  await withTransaction(async (tx) => {
    await lockOwnedEnvelopeFolder(userId, envelopeId, tx);
    const current = await queryOne<{
      expiresAt: number | null;
      status: EnvelopeRecord["status"];
    }>(
      tx,
      `
        SELECT expires_at AS "expiresAt", status
        FROM envelopes
        WHERE id = $1 AND user_id = $2
        -- The lock an UPDATE takes, not FOR UPDATE: storing an audit event
        -- needs a share of this row for its foreign key, and FOR UPDATE
        -- would deadlock with a signer opening the signing page.
        FOR NO KEY UPDATE
      `,
      [envelopeId, userId],
    );

    if (!current) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    if (current.status !== "sent") {
      throw new EnvelopeMutationError(
        "Only an envelope that is out for signature has a deadline to change.",
        409,
      );
    }

    await tx.query(
      `
        UPDATE envelopes
        SET expires_at = $1, expiry_notified_at = NULL, updated_at = $2
        WHERE id = $3
      `,
      [expiresAt, nowUnixTimestamp, envelopeId],
    );
    await tx.query(
      `
        UPDATE signers
        -- A link made for an app keeps its own short life: a later
        -- deadline must not bring it back or stretch it, though an
        -- earlier one still cuts it short.
        SET signing_token_expires_at = CASE
              WHEN embed_origin IS NULL THEN $1
              ELSE LEAST(signing_token_expires_at, $1)
            END,
            updated_at = $2
        WHERE envelope_id = $3
          AND status = 'notified'
          AND signing_token_hash IS NOT NULL
      `,
      [expiresAt, nowUnixTimestamp, envelopeId],
    );
    await recordAuditEvent(
      {
        actorEmail: input.senderEmail,
        actorType: "sender",
        createdAt: nowUnixTimestamp,
        envelopeId,
        event: "deadline_changed",
        ipAddress: input.ipAddress ?? null,
        metadata: { expiresAt, previousExpiresAt: current.expiresAt },
        userAgent: input.userAgent ?? null,
      },
      tx,
    );
  }, database);

  return changeDeadlineResponseSchema.parse({
    envelopeId,
    expiresAt,
    expiresAtLabel: formatDeadline(expiresAt),
  });
}

const SENT_ENVELOPE_SIGNER_CORRECTION_MESSAGE =
  "Only an envelope that is out for signature can have a signer corrected.";

const EMBEDDED_SIGNER_CORRECTION_MESSAGE =
  "This envelope is signed in another app, which says who signs. Void it and send a new one to change a signer.";

/**
 * Fixes the name and/or email of a signer who has not signed or declined on
 * an envelope that is out for signature. The signing link they already have
 * stops working. If it is their turn, a new invitation goes to the
 * corrected address.
 *
 * The envelope and signer rows stay locked until that invitation is sent
 * or refused, so another correction of the same person waits. A failed
 * send rolls the whole transaction back: the last committed identity
 * returns, the original link still works when nothing succeeded, and no
 * signer_corrected event is left behind. The audit event is written in
 * this same transaction after a successful send, so overlapping
 * corrections cannot appear out of order.
 */
export async function correctSentEnvelopeSigner(
  userId: string,
  envelopeId: string,
  signerId: string,
  input: unknown,
  context: CorrectSentEnvelopeSignerContext,
  {
    database = getDb(),
    emailService,
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: CorrectSentEnvelopeSignerOptions = {},
): Promise<CorrectSentSignerResult> {
  const parsedInput = correctSentSignerSchema.parse(input);

  if (await isEmbeddedEnvelope(envelopeId, database, userId)) {
    throw new EnvelopeMutationError(EMBEDDED_SIGNER_CORRECTION_MESSAGE, 409);
  }

  // Read settings before taking the envelope lock: an uncached read inside the
  // transaction borrows a second pool connection, and overlapping corrections
  // holding the others while they wait on the lock would starve it.
  const branding = await getBranding();
  const emailAddresses = emailService ? null : await resolveEmailAddresses();

  return withTransaction(async (tx) => {
    await lockOwnedEnvelopeFolder(userId, envelopeId, tx);
    const envelope = await queryOne<{
      delivery: string;
      expiresAt: number | null;
      part11: boolean;
      status: EnvelopeRecord["status"];
      title: string;
      updatedAt: number;
      userId: string;
    }>(
      tx,
      `
        SELECT
          delivery,
          expires_at AS "expiresAt",
          part11,
          status,
          title,
          updated_at AS "updatedAt",
          user_id AS "userId"
        FROM envelopes
        WHERE id = $1 AND user_id = $2
        FOR NO KEY UPDATE
      `,
      [envelopeId, userId],
    );

    if (!envelope) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    if (envelope.status !== "sent") {
      throw new EnvelopeMutationError(
        SENT_ENVELOPE_SIGNER_CORRECTION_MESSAGE,
        409,
      );
    }

    // Checked again on the locked row: an embedded send may have landed
    // since the check above.
    if (envelope.delivery === "embedded") {
      throw new EnvelopeMutationError(EMBEDDED_SIGNER_CORRECTION_MESSAGE, 409);
    }

    if (envelope.part11) {
      throw new EnvelopeMutationError(
        "This envelope was sent in Part 11 mode. The signer's identity is bound to their account and cannot be corrected.",
        409,
      );
    }

    const signer = await queryOne<{
      consentedAt: number | null;
      email: string;
      emailCodeAttempts: number;
      emailCodeExpiresAt: number | null;
      emailCodeHash: string | null;
      emailCodeSentAt: number | null;
      lastNotifiedAt: number | null;
      name: string;
      role: string;
      signOrder: number;
      signingTokenExpiresAt: number | null;
      signingTokenHash: string | null;
      status: SignerRecord["status"];
      updatedAt: number;
    }>(
      tx,
      `
        SELECT
          consented_at AS "consentedAt",
          email,
          email_code_attempts AS "emailCodeAttempts",
          email_code_expires_at AS "emailCodeExpiresAt",
          email_code_hash AS "emailCodeHash",
          email_code_sent_at AS "emailCodeSentAt",
          last_notified_at AS "lastNotifiedAt",
          name,
          role,
          sign_order AS "signOrder",
          signing_token_expires_at AS "signingTokenExpiresAt",
          signing_token_hash AS "signingTokenHash",
          status,
          updated_at AS "updatedAt"
        FROM signers
        WHERE id = $1 AND envelope_id = $2
        FOR NO KEY UPDATE
      `,
      [signerId, envelopeId],
    );

    if (!signer || (signer.role !== "signer" && signer.role !== "approver")) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    if (signer.status === "signed") {
      throw new EnvelopeMutationError(
        "This person has already signed and cannot be corrected.",
        409,
      );
    }

    if (signer.status === "declined") {
      throw new EnvelopeMutationError(
        "This person has already declined and cannot be corrected.",
        409,
      );
    }

    const nextName = parsedInput.name ?? signer.name;
    const nextEmail = parsedInput.email ?? signer.email;

    if (
      nextName === signer.name &&
      nextEmail.toLowerCase() === signer.email.toLowerCase()
    ) {
      return correctSentSignerResponseSchema.parse({
        email: signer.email,
        envelopeId,
        invitationSent: false,
        name: signer.name,
        signerId,
      });
    }

    const duplicate = await queryOne<{ id: string; role: string }>(
      tx,
      `
        SELECT id, role
        FROM signers
        WHERE envelope_id = $1
          AND lower(email) = $2
          AND id <> $3
      `,
      [envelopeId, nextEmail.toLowerCase(), signerId],
    );

    if (duplicate) {
      throw new EnvelopeMutationError(
        duplicate.role === "cc"
          ? duplicateCopyRecipientEmailMessage
          : duplicateSignerEmailMessage,
        400,
      );
    }

    let issuedLink: IssuedSigningLink | null = null;
    let tokenHash: string | null = null;
    let tokenExpiresAt: number | null = null;
    let lastNotifiedAt = signer.lastNotifiedAt;
    const invitationNeeded = signer.status === "notified";

    if (invitationNeeded) {
      const remainingSeconds =
        typeof envelope.expiresAt === "number" &&
        envelope.expiresAt > nowUnixTimestamp
          ? envelope.expiresAt - nowUnixTimestamp
          : typeof envelope.expiresAt === "number"
            ? 1
            : signingLinkLifetimeSeconds(envelope.expiresAt, nowUnixTimestamp);

      issuedLink = await issueSigningLink({
        expiresInSeconds: remainingSeconds,
        issuedAt: nowUnixTimestamp,
      });
      tokenHash = issuedLink.tokenHash;
      tokenExpiresAt =
        typeof envelope.expiresAt === "number"
          ? envelope.expiresAt
          : issuedLink.exp;
      lastNotifiedAt = nowUnixTimestamp;
    }

    const updatedSigner = await tx.query(
      `
        UPDATE signers
        SET
          name = $1,
          email = $2,
          signing_token_hash = $3,
          signing_token_expires_at = $4,
          last_notified_at = $5,
          consented_at = NULL,
          email_code_hash = NULL,
          email_code_expires_at = NULL,
          email_code_attempts = 0,
          email_code_sent_at = NULL,
          updated_at = $6
        WHERE id = $7
          AND envelope_id = $8
          AND status IN ('pending', 'notified')
      `,
      [
        nextName,
        nextEmail,
        tokenHash,
        tokenExpiresAt,
        lastNotifiedAt,
        nowUnixTimestamp,
        signerId,
        envelopeId,
      ],
    );

    if (updatedSigner.rowCount !== 1) {
      throw new EnvelopeMutationError(
        "This person has already signed or declined and cannot be corrected.",
        409,
      );
    }

    await tx.query(
      `
        UPDATE envelopes
        SET updated_at = $1
        WHERE id = $2
      `,
      [nowUnixTimestamp, envelopeId],
    );

    if (invitationNeeded && issuedLink) {
      const mailer =
        emailService ??
        createEmailService(
          emailAddresses === null
            ? {}
            : { resolveAddresses: () => Promise.resolve(emailAddresses) },
        );
      const invitationMessageId = (
        await mailer.send(
          buildSigningInvitationEmail({
            branding,
            envelopeTitle: envelope.title,
            expiresAt: envelope.expiresAt,
            role: signer.role === "approver" ? "approver" : "signer",
            senderName: context.senderName,
            signerEmail: nextEmail,
            signerName: nextName,
            signingUrl: issuedLink.url,
          }),
        )
      ).messageId;

      await recordAuditEvent(
        {
          actorEmail: context.senderEmail,
          actorType: "sender",
          createdAt: nowUnixTimestamp,
          envelopeId,
          event: "signer_corrected",
          ipAddress: context.ipAddress ?? null,
          metadata: {
            previousEmail: signer.email,
            previousName: signer.name,
            signerEmail: nextEmail,
            signerId,
            signerName: nextName,
            signerOrder: signer.signOrder,
          },
          userAgent: context.userAgent ?? null,
        },
        tx,
      );
      await recordEmailSent(
        {
          envelopeId,
          messageId: invitationMessageId,
          recipient: nextEmail,
          signerId,
          template: "signing_invitation",
        },
        tx,
      );

      return correctSentSignerResponseSchema.parse({
        email: nextEmail,
        envelopeId,
        invitationSent: true,
        name: nextName,
        signerId,
      });
    }

    await recordAuditEvent(
      {
        actorEmail: context.senderEmail,
        actorType: "sender",
        createdAt: nowUnixTimestamp,
        envelopeId,
        event: "signer_corrected",
        ipAddress: context.ipAddress ?? null,
        metadata: {
          previousEmail: signer.email,
          previousName: signer.name,
          signerEmail: nextEmail,
          signerId,
          signerName: nextName,
          signerOrder: signer.signOrder,
        },
        userAgent: context.userAgent ?? null,
      },
      tx,
    );

    return correctSentSignerResponseSchema.parse({
      email: nextEmail,
      envelopeId,
      invitationSent: false,
      name: nextName,
      signerId,
    });
  }, database);
}

/**
 * Turns automatic reminders on, off, or to another interval for an envelope
 * that is out for signature. The interval counts from the last time the
 * signer was written to, so turning them on can send one the next day.
 */
export async function changeEnvelopeReminders(
  userId: string,
  envelopeId: string,
  reminderIntervalDays: number | null,
  {
    database = getDb(),
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: { database?: DbExecutor; nowUnixTimestamp?: number } = {},
): Promise<ChangeRemindersResponse> {
  const updated = await database.query(
    `
      UPDATE envelopes
      SET reminder_interval_days = $1, updated_at = $2
      WHERE id = $3 AND user_id = $4 AND status = 'sent'
        AND ${canAccessEnvelopeFolderCondition("$4")}
    `,
    [reminderIntervalDays, nowUnixTimestamp, envelopeId, userId],
  );

  if (updated.rowCount !== 1) {
    const access = await resolveEnvelopeViewerAccess(
      userId,
      envelopeId,
      database,
    );

    throw access?.viewerIsOwner
      ? new EnvelopeMutationError(
          "Reminders can only be changed while an envelope is out for signature.",
          409,
        )
      : new EnvelopeMutationError("Envelope not found.", 404);
  }

  return changeRemindersResponseSchema.parse({
    envelopeId,
    reminderIntervalDays,
  });
}

/** A signer signed between the void's first read and its lock. */
class VoidRouteChangedError extends Error {
  constructor() {
    super("A signer signed while the envelope was being voided.");
    this.name = "VoidRouteChangedError";
  }
}

export async function voidSentEnvelope(
  userId: string,
  envelopeId: string,
  input: VoidEnvelopeInput,
  options: VoidEnvelopeOptions = {},
): Promise<VoidEnvelopeResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await voidSentEnvelopeOnce(userId, envelopeId, input, options);
    } catch (error) {
      if (!(error instanceof VoidRouteChangedError)) {
        throw error;
      }

      if (attempt >= 5) {
        throw new EnvelopeMutationError(
          "Signers were signing while you voided this envelope. Try again.",
          409,
        );
      }
    }
  }
}

async function voidSentEnvelopeOnce(
  userId: string,
  envelopeId: string,
  input: VoidEnvelopeInput,
  {
    database = getDb(),
    emailService: givenEmailService,
    storageService: givenStorageService,
  }: VoidEnvelopeOptions = {},
): Promise<VoidEnvelopeResult> {
  const envelope = await getEnvelopeByIdForUser(userId, envelopeId, database);

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.status !== "sent") {
    throw new EnvelopeMutationError("Only sent envelopes can be voided.", 409);
  }

  const reason = input.reason?.trim().slice(0, 1000) || null;

  if (envelope.part11 && !reason) {
    throw new EnvelopeMutationError(
      "Give a reason for voiding. Part 11 records keep it in the audit trail.",
      400,
    );
  }

  const signers = await listSignersForEnvelopeId(envelopeId, database);
  const notifiedSigners = signers.filter(
    (signer) => signer.status === "notified",
  );
  const currentSigner = notifiedSigners[0];
  // Everyone who was sent the envelope hears that it was voided: the signer
  // whose turn it is, and those who already signed it. Signers still waiting
  // for their turn were never invited, so they get nothing.
  const invitedSigners = signers.filter(
    (signer) => signer.status === "notified" || signer.status === "signed",
  );
  const voidedAt = Math.floor(Date.now() / 1000);
  const emailService =
    invitedSigners.length > 0
      ? (givenEmailService ?? createEmailServiceForSending())
      : null;
  const storageService = givenStorageService ?? createStorageService();
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
    metadata:
      currentSigner || reason
        ? {
            ...(currentSigner
              ? {
                  signerEmail: currentSigner.email,
                  signerId: currentSigner.id,
                  signerName: currentSigner.name,
                  signerOrder: currentSigner.signOrder,
                }
              : {}),
            ...(reason ? { reason } : {}),
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
  const storedCertificateKeys: string[] = [];
  // The seal's key and the install's name, read before the transaction:
  // sealing inside it then needs no second connection from the pool.
  const seal = await loadInstallSealer();

  await withTransaction(async (tx) => {
    await lockOwnedEnvelopeFolder(userId, envelopeId, tx);
    // Taken before the certificates are made. They have fixed keys, so a
    // second void, a decline or the last signature at the same time waits
    // here, then stops below: it never writes over, or deletes, the files
    // the first one saved.
    const locked = await queryOne<{ status: EnvelopeRecord["status"] }>(
      tx,
      `
        SELECT status
        FROM envelopes
        WHERE id = $1 AND user_id = $2
        -- The lock an UPDATE takes, not FOR UPDATE: storing an audit event
        -- needs a share of this row for its foreign key.
        FOR NO KEY UPDATE
      `,
      [envelopeId, userId],
    );

    if (!locked) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    if (locked.status !== "sent") {
      throw new EnvelopeMutationError(
        "Only sent envelopes can be voided.",
        409,
      );
    }

    // The certificates show the signers as they were read before the lock.
    // A signer who signed in between (one of several signing at the same
    // time, say) would be shown as still waiting, without their signature
    // in the audit trail shown. Then the void starts again from what is
    // there now.
    const statusesNow = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM signers WHERE envelope_id = $1 AND role IN ('signer', 'approver')`,
      [envelopeId],
    );

    if (
      statusesNow.rows.length !== signers.length ||
      statusesNow.rows.some(
        (row) =>
          signers.find((signer) => signer.id === row.id)?.status !== row.status,
      )
    ) {
      throw new VoidRouteChangedError();
    }

    // The audit trail the certificates show, read with the envelope and its
    // audit chain held, so an event recorded since the page was opened is
    // on them and none can be added before the void is.
    await lockEnvelopeAuditChain(envelopeId, tx);

    const auditEvents = [
      ...(await listAuditEventsForEnvelope(envelopeId, tx)),
      voidedAuditEvent,
    ];

    const certificate = await storeEnvelopeCertificatePdf(
      {
        auditEvents,
        certificate: canonicalCertificate,
        envelope: voidedEnvelope,
        signers: voidedSigners,
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
        envelope: voidedEnvelope,
        signers: voidedSigners,
      },
      {
        seal,
        storageService,
      },
    );
    storedCertificateKeys.push(recipientCertificate.key);

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
        recipientCertificate.sha256,
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
          spent_signing_token_hash = signing_token_hash,
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
  }, database).catch(async (error: unknown) => {
    // Only files this call stored, so only once the envelope was its to end.
    // That includes a failed COMMIT: the cleanup keeps the files if the
    // envelope did end after all.
    if (storedCertificateKeys.length > 0) {
      await removeUnclaimedEnvelopeCertificates(
        {
          envelopeId: envelopeId,
          keys: storedCertificateKeys,
          storageService,
        },
        database,
      );
    }

    throw error;
  });

  if (emailService && invitedSigners.length > 0) {
    const branding = await getBranding().catch(() => null);

    await Promise.all(
      invitedSigners.map(async (signer) => {
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
              signerSigned: signer.status === "signed",
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
  }

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

  const pages = await listEnvelopePagesForEnvelopeId(envelopeId, database);
  const pageNumbers = new Set(pages.map((page) => page.pageNumber));
  const usedFieldIds = new Set<string>();
  const updatedAt = Math.floor(Date.now() / 1000);
  const preparedFields = parsedInput.fields.map((field) => {
    const parsedField = fieldPlacementSchema.parse(field);

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
      id: fieldId,
      updatedAt,
    };
  });

  const { fields, fieldsRevision } = await withTransaction(async (tx) => {
    await lockDraftEnvelope(userId, envelopeId, tx);

    // Under the draft's lock, so two saves (or a signer removal) cannot both
    // pass this check: a save made against an older list (from a page the
    // sender has since left, say) does not overwrite a newer one.
    if (
      parsedInput.expectedRevision !== undefined &&
      parsedInput.expectedRevision !==
        (await readFieldsRevision(envelopeId, tx))
    ) {
      throw new EnvelopeMutationError(FIELDS_CHANGED_MESSAGE, 409);
    }

    // Checked under the draft's lock so a signer removed or turned into an
    // approver right before this transaction acquired the lock is refused
    // cleanly instead of failing on fields_signer_envelope_fk or the approver
    // trigger (issue #224).
    const signers = await listSignersForEnvelopeId(envelopeId, tx);
    const signerIds = new Set(signers.map((signer) => signer.id));
    const approverIds = new Set(
      signers
        .filter((signer) => signer.role === "approver")
        .map((signer) => signer.id),
    );

    for (const field of preparedFields) {
      if (!signerIds.has(field.signerId)) {
        throw new EnvelopeMutationError(
          "Each field must be assigned to an existing signer on this envelope.",
          400,
        );
      }

      if (approverIds.has(field.signerId)) {
        throw new EnvelopeMutationError(
          "Approvers approve or reject the document and have no fields. Give the field to a signer.",
          400,
        );
      }
    }

    const existingFields =
      (await listFieldsForEnvelopeIds([envelopeId], tx)).get(envelopeId) ?? [];
    const existingFieldMetadata = new Map(
      existingFields.map((field) => [field.id, field.createdAt] as const),
    );

    await tx.query(
      `
        DELETE FROM fields
        WHERE envelope_id = $1
      `,
      [envelopeId],
    );

    for (const [index, field] of preparedFields.entries()) {
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
            updated_at,
            options,
            group_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL, NULL, NULL, NULL, $12, $13, $14::jsonb, $15
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
          existingFieldMetadata.get(field.id) ?? updatedAt + index,
          field.updatedAt,
          field.type === "dropdown"
            ? JSON.stringify(field.options ?? [])
            : null,
          field.groupId ?? null,
        ],
      );
    }

    const updated = await tx.query<{ fields_revision: number }>(
      `
        UPDATE envelopes
        SET updated_at = $1, fields_revision = fields_revision + 1
        WHERE id = $2 AND user_id = $3
        RETURNING fields_revision
      `,
      [updatedAt, envelopeId, userId],
    );
    const savedFields =
      (await listFieldsForEnvelopeIds([envelopeId], tx)).get(envelopeId) ?? [];

    return {
      fields: savedFields,
      fieldsRevision: updated.rows[0]?.fields_revision ?? 0,
    };
  }, database);

  return replaceFieldsResponseSchema.parse({
    envelopeId,
    fields,
    fieldsRevision,
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
  const existingCopyRecipients = await listCopyRecipientsForEnvelopeId(
    envelopeId,
    database,
  );
  const existingCopyRecipientIds = new Set(
    existingCopyRecipients.map((recipient) => recipient.id),
  );
  const usedCopyRecipientIds = new Set<string>();
  // Left out of the request means "leave them as they are".
  const nextCopyRecipients = (
    parsedInput.copyRecipients ?? existingCopyRecipients
  ).map((recipient, index) => {
    const persistedId =
      recipient.id && existingCopyRecipientIds.has(recipient.id)
        ? recipient.id
        : randomUUID();

    // Two rows of one request claiming to be the same saved recipient.
    if (usedCopyRecipientIds.has(persistedId)) {
      throw new EnvelopeMutationError(
        "Each copy recipient must be unique.",
        400,
      );
    }

    usedCopyRecipientIds.add(persistedId);

    return {
      email: recipient.email,
      id: persistedId,
      name: recipient.name,
      // After every signer, and clear of the numbers the rewrite below
      // parks rows on.
      signOrder: COPY_RECIPIENT_SIGN_ORDER_BASE + index + 1,
    };
  });
  const signerEmails = new Set(
    parsedInput.signers.map((signer) => signer.email.toLowerCase()),
  );

  // Checked by the schema when both lists arrive together. This covers a
  // request that names only signers, one of whom is already a copy recipient.
  if (
    nextCopyRecipients.some((recipient) =>
      signerEmails.has(recipient.email.toLowerCase()),
    )
  ) {
    throw new EnvelopeMutationError(duplicateCopyRecipientEmailMessage, 400);
  }

  const maxSigners = getMaxSignersPerEnvelope();

  if (parsedInput.signers.length > maxSigners) {
    throw new EnvelopeMutationError(describeSignerLimit(maxSigners), 400);
  }

  // Each signer's step of the signing order, in the order of the list.
  let signingSteps: number[];

  try {
    signingSteps = normalizeSigningSteps(
      parsedInput.signers.map((signer) => signer.signingStep),
    );
  } catch (error) {
    if (error instanceof SigningStepError) {
      throw new EnvelopeMutationError(error.message, 400);
    }

    throw error;
  }

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
      role: signer.role ?? "signer",
      signatureMeaning: signer.signatureMeaning,
      signOrder: index + 1,
      signingStep: signingSteps[index]!,
    };
  });

  await withTransaction(async (tx) => {
    await lockDraftEnvelope(userId, envelopeId, tx);

    // Copy recipients hold nothing but a name and an address while the
    // envelope is a draft, so they are simply written again below.
    await tx.query(
      `DELETE FROM signers WHERE envelope_id = $1 AND role = 'cc'`,
      [envelopeId],
    );

    const lockedSigners = await listSignersForEnvelopeId(envelopeId, tx);
    const lockedSignerRoles = new Map(
      lockedSigners.map((signer) => [signer.id, signer.role ?? "signer"]),
    );

    // Reject a stale save whose signer ID existed in the pre-lock snapshot
    // but was removed concurrently before this transaction acquired the lock;
    // inserting it anew would drop its saved access_code_hash,
    // require_email_code, or signature_meaning.
    for (const signer of nextSigners) {
      if (
        !lockedSignerRoles.has(signer.id) &&
        existingSignerIds.has(signer.id)
      ) {
        throw new EnvelopeMutationError(
          "These signers were changed somewhere else, so this change was not saved. Reload the page to see the latest signers.",
          409,
        );
      }
    }
    // Any removal of a signer (which cascades to delete their fields) or
    // conversion of a signer into an approver invalidates an open Place fields
    // view, so bump fields_revision under the lock (issue #224).
    let fieldsInvalidated = false;

    if (lockedSigners.length > 0) {
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
      const previousRole = lockedSignerRoles.get(signer.id);

      if (previousRole !== undefined) {
        await tx.query(
          `
            UPDATE signers
            SET
              name = $1,
              email = $2,
              sign_order = $3,
              updated_at = $4,
              access_code_hash = CASE WHEN $7::boolean THEN $8 ELSE access_code_hash END,
              require_email_code = COALESCE($9, require_email_code),
              signature_meaning = CASE WHEN $10::boolean THEN $11 ELSE signature_meaning END,
              signing_step = $12,
              role = $13
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
            signer.signatureMeaning !== undefined,
            signer.signatureMeaning ?? null,
            signer.signingStep,
            signer.role,
          ],
        );

        // Someone who becomes an approver has no fields any more.
        if (signer.role === "approver") {
          const deletedApproverFields = await tx.query(
            `DELETE FROM fields WHERE envelope_id = $1 AND signer_id = $2`,
            [envelopeId, signer.id],
          );

          if (
            (deletedApproverFields.rowCount ?? 0) > 0 ||
            previousRole !== "approver"
          ) {
            fieldsInvalidated = true;
          }
        }
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
              require_email_code,
              signature_meaning,
              signing_step,
              role
            ) VALUES (
              $1, $2, $3, $4, $5, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $6, $7, $8, $9, $10, $11, $12
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
            signer.signatureMeaning ?? null,
            signer.signingStep,
            signer.role,
          ],
        );
      }
    }

    const deletedSigners = await tx.query(
      `
        DELETE FROM signers
        WHERE envelope_id = $1
          AND id NOT IN (${buildInClausePlaceholders(nextSigners.length, 2)})
      `,
      [envelopeId, ...nextSigners.map((signer) => signer.id)],
    );

    if ((deletedSigners.rowCount ?? 0) > 0) {
      fieldsInvalidated = true;
    }

    for (const recipient of nextCopyRecipients) {
      await tx.query(
        `
          INSERT INTO signers (
            id, envelope_id, name, email, sign_order, status, role,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, 'pending', 'cc', $6, $6)
        `,
        [
          recipient.id,
          envelopeId,
          recipient.name,
          recipient.email,
          recipient.signOrder,
          updatedAt,
        ],
      );
    }

    await tx.query(
      fieldsInvalidated
        ? `
            UPDATE envelopes
            SET updated_at = $1, fields_revision = fields_revision + 1
            WHERE id = $2 AND user_id = $3
          `
        : `
            UPDATE envelopes
            SET updated_at = $1
            WHERE id = $2 AND user_id = $3
          `,
      [updatedAt, envelopeId, userId],
    );
  }, database);

  const checks = await listSignerCheckSettings(envelopeId, database);

  return replaceSignersResponseSchema.parse({
    copyRecipients: nextCopyRecipients.map(({ email, id, name }) => ({
      email,
      id,
      name,
    })),
    envelopeId,
    redirectPath: `/envelopes/${envelopeId}/prepare`,
    signers: (await listSignersForEnvelopeId(envelopeId, database)).map(
      (signer) => ({
        email: signer.email,
        hasAccessCode: checks.get(signer.id)?.hasAccessCode ?? false,
        id: signer.id,
        name: signer.name,
        requireEmailCode: checks.get(signer.id)?.requireEmailCode ?? false,
        role: signer.role ?? "signer",
        signatureMeaning: checks.get(signer.id)?.signatureMeaning ?? null,
        signOrder: signer.signOrder,
        signingStep: signingStepOf(signer),
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
