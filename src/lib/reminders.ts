import { type Branding } from "./branding.ts";
import {
  formatDeadline,
  isEnvelopeExpired,
  signingLinkLifetimeSeconds,
} from "./envelope-deadline.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import {
  manualNudgeResponseSchema,
  type EnvelopeRecord,
} from "./schemas/envelope.ts";
import { type SignerRecord } from "./schemas/signer.ts";
import { getBranding } from "./settings.ts";
import {
  lockEnvelopeAuditChain,
  recordAuditEvent,
  recordEmailSent,
} from "./services/audit.ts";
import {
  createEmailService,
  EMAIL_NOT_CONNECTED_MESSAGE,
  isEmailNotConnectedError,
  type EmailService,
} from "./services/email.ts";
import {
  buildDeadlineLine,
  describeRequestedAction,
} from "./services/signing-invitation-email.ts";
import { isEmbeddedEnvelope } from "./embedding.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import {
  formatReminderAvailableAt,
  getManualNudgeAvailableAt,
  isAutomaticReminderDue,
} from "./services/reminders.ts";
import {
  issueSigningLink,
  type IssuedSigningLink,
} from "./services/signing-links.ts";
import { escapeHtml } from "./utils/html.ts";

type ReminderEnvelopeRow = {
  delivery: "email" | "embedded";
  expiresAt: number | null;
  id: string;
  ownerEmail: string;
  ownerName: string | null;
  reminderIntervalDays: number | null;
  status: EnvelopeRecord["status"];
  title: string;
  updatedAt: number;
  userId: string;
};

type ReminderSignerRow = {
  email: string;
  envelopeId: string;
  id: string;
  lastNotifiedAt: number | null;
  lastNudgedAt: number | null;
  name: string;
  role: string;
  signOrder: number;
  signingTokenExpiresAt: number | null;
  signingTokenHash: string | null;
  status: SignerRecord["status"];
  updatedAt: number;
};

type ManualNudgeInput = {
  ipAddress?: string | null;
  senderEmail: string;
  senderName: string;
  userAgent?: string | null;
};

/**
 * Who is asking for a reminder: the sender, by pressing the button, or the
 * daily job, because the envelope's reminder interval has passed.
 */
type ReminderRequest =
  | ({ kind: "manual"; userId: string } & ManualNudgeInput)
  | { kind: "automatic" };

type PersistedReminder = {
  auditEventId: string;
  envelopeExpiresAt: number | null;
  envelopeId: string;
  envelopeTitle: string;
  issuedLink: IssuedSigningLink;
  nextAvailableAt: number;
  previousEnvelopeUpdatedAt: number;
  previousSigner: Pick<
    ReminderSignerRow,
    | "id"
    | "lastNotifiedAt"
    | "lastNudgedAt"
    | "signingTokenExpiresAt"
    | "signingTokenHash"
    | "updatedAt"
  >;
  signerEmail: string;
  signerId: string;
  signerName: string;
  /** An approver is reminded to approve, not to sign. */
  signerRole: "approver" | "signer";
  senderName: string;
  userId: string;
};

type SendReminderOptions = {
  database?: DbPool;
  emailService?: EmailService;
  nowUnixTimestamp?: number;
};

export class ReminderMutationError extends Error {
  readonly nextAvailableAt: number | null;
  readonly nextAvailableAtLabel: string | null;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode: number,
    {
      nextAvailableAt = null,
      nextAvailableAtLabel = null,
    }: {
      nextAvailableAt?: number | null;
      nextAvailableAtLabel?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "ReminderMutationError";
    this.nextAvailableAt = nextAvailableAt;
    this.nextAvailableAtLabel = nextAvailableAtLabel;
    this.statusCode = statusCode;
  }
}

/**
 * The envelope, and only for its owner when a user is given. With a lock,
 * inside a transaction, the envelope's row is held until the transaction
 * ends, so its deadline cannot be moved in between.
 *
 * The lock is the one an UPDATE takes (NO KEY UPDATE), not the stronger
 * FOR UPDATE. Storing an audit event checks its foreign key, which needs a
 * share of this row while it holds the envelope's audit chain. FOR UPDATE
 * would refuse that share, and a reminder waiting for the chain would then
 * deadlock with a signer opening the signing page.
 */
async function getReminderEnvelope(
  envelopeId: string,
  userId: string | null,
  database: DbExecutor,
  { lock = false }: { lock?: boolean } = {},
): Promise<ReminderEnvelopeRow | null> {
  return queryOne<ReminderEnvelopeRow>(
    database,
    `
      SELECT
        e.id,
        e.user_id AS "userId",
        e.title,
        e.status,
        e.delivery,
        e.expires_at AS "expiresAt",
        e.reminder_interval_days AS "reminderIntervalDays",
        e.updated_at AS "updatedAt",
        u.email AS "ownerEmail",
        u.name AS "ownerName"
      FROM envelopes e
      JOIN "user" u ON u.id = e.user_id
      WHERE e.id = $1
        AND ($2::text IS NULL OR e.user_id = $2)
      ${lock ? "FOR NO KEY UPDATE OF e" : ""}
    `,
    [envelopeId, userId],
  );
}

/**
 * Everyone whose turn it is: one signer, or every signer of a step that
 * signs at the same time. Each is reminded on their own, with their own
 * link and their own wait between reminders.
 */
async function listWaitingSignerIds(
  envelopeId: string,
  database: DbExecutor,
): Promise<string[]> {
  const rows = await queryMany<{ id: string }>(
    database,
    `
      SELECT id
      FROM signers
      WHERE envelope_id = $1
        AND status = 'notified'
      ORDER BY sign_order ASC, id ASC
    `,
    [envelopeId],
  );

  return rows.map((row) => row.id);
}

/** The waiting signer, or the first of them when none is named. */
async function getCurrentSignerForEnvelope(
  envelopeId: string,
  database: DbExecutor,
  signerId: string | null = null,
): Promise<ReminderSignerRow | null> {
  return queryOne<ReminderSignerRow>(
    database,
    `
      SELECT
        id,
        envelope_id AS "envelopeId",
        name,
        email,
        role,
        sign_order AS "signOrder",
        status,
        signing_token_hash AS "signingTokenHash",
        signing_token_expires_at AS "signingTokenExpiresAt",
        last_notified_at AS "lastNotifiedAt",
        last_nudged_at AS "lastNudgedAt",
        updated_at AS "updatedAt"
      FROM signers
      WHERE envelope_id = $1
        AND status = 'notified'
        AND ($2::text IS NULL OR id = $2)
      ORDER BY sign_order ASC, id ASC
      LIMIT 1
    `,
    [envelopeId, signerId],
  );
}

function buildReminderEmail(input: {
  branding: Branding;
  envelopeId: string;
  envelopeTitle: string;
  expiresAt?: number | null;
  kind: ReminderRequest["kind"];
  senderName: string;
  signerEmail: string;
  signerName: string;
  signerRole?: "approver" | "signer";
  signingUrl: string;
}) {
  const automatic = input.kind === "automatic";
  const action = describeRequestedAction(input.signerRole);
  const subject = automatic
    ? `Reminder: ${input.senderName} is waiting for your ${action.noun} on "${input.envelopeTitle}"`
    : `${input.senderName} sent you a reminder to ${action.verb} "${input.envelopeTitle}"`;
  const introLine = automatic
    ? `${input.senderName} is still waiting for your ${action.noun} on "${input.envelopeTitle}", sent through ${input.branding.productName}.`
    : `${input.senderName} sent you a reminder to ${action.verb} "${input.envelopeTitle}" through ${input.branding.productName}.`;
  const deadlineLine = buildDeadlineLine(input.expiresAt);
  const textBody = [
    `Hi ${input.signerName},`,
    "",
    introLine,
    "",
    `${action.linkText} here:`,
    input.signingUrl,
    ...(deadlineLine ? ["", deadlineLine] : []),
    "",
    `You do not need a ${input.branding.productName} account to ${action.accountLine}.`,
    "If you receive a newer invitation or reminder link, use the newest one.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.signerName)},</p>`,
    `<p>${escapeHtml(introLine)}</p>`,
    `<p><a href="${escapeHtml(input.signingUrl)}">${escapeHtml(action.linkText)}</a></p>`,
    deadlineLine ? `<p>${escapeHtml(deadlineLine)}</p>` : "",
    `<p>You do not need a ${escapeHtml(input.branding.productName)} account to ${action.accountLine}.</p>`,
    "<p>If you receive a newer invitation or reminder link, use the newest one.</p>",
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
    template: automatic
      ? ("automatic_reminder" as const)
      : ("manual_nudge" as const),
    textBody: legalFooter.textBody,
    to: input.signerEmail,
  };
}

/** Why the daily job should leave an envelope alone, or null to go ahead. */
function getAutomaticReminderObstacle(
  envelope: ReminderEnvelopeRow,
  signer: ReminderSignerRow,
  now: number,
): string | null {
  if (envelope.reminderIntervalDays === null) {
    return "Automatic reminders are off for this envelope.";
  }

  return isAutomaticReminderDue(
    {
      intervalDays: envelope.reminderIntervalDays,
      lastNotifiedAt: signer.lastNotifiedAt,
      lastNudgedAt: signer.lastNudgedAt,
    },
    now,
  )
    ? null
    : "This envelope's next reminder is not due yet.";
}

async function persistReminder(
  envelopeId: string,
  request: ReminderRequest,
  dispatchedAt: number,
  database: DbPool,
  signerId: string | null = null,
): Promise<PersistedReminder> {
  const userId = request.kind === "manual" ? request.userId : null;
  const envelope = await getReminderEnvelope(envelopeId, userId, database);

  if (!envelope) {
    throw new ReminderMutationError("This envelope is unavailable.", 404);
  }

  if (envelope.status !== "sent") {
    throw new ReminderMutationError(
      "Only sent envelopes can receive reminders.",
      409,
    );
  }

  const signer = await getCurrentSignerForEnvelope(
    envelopeId,
    database,
    signerId,
  );

  if (!signer) {
    throw new ReminderMutationError(
      "This envelope is no longer waiting on a signer.",
      409,
    );
  }

  if (isEnvelopeExpired(envelope, dispatchedAt)) {
    throw new ReminderMutationError(
      `This request expired on ${formatDeadline(envelope.expiresAt!)}. Set a new deadline before sending a reminder.`,
      409,
    );
  }

  // The reminder's link ends at the envelope's deadline, like every other.
  const issuedLink = await issueSigningLink({
    expiresInSeconds: signingLinkLifetimeSeconds(
      envelope.expiresAt,
      dispatchedAt,
    ),
    issuedAt: dispatchedAt,
  });
  return withTransaction(async (tx) => {
    const persistedEnvelope = await getReminderEnvelope(
      envelopeId,
      userId,
      tx,
      { lock: true },
    );

    if (!persistedEnvelope) {
      throw new ReminderMutationError("This envelope is unavailable.", 404);
    }

    if (persistedEnvelope.status !== "sent") {
      throw new ReminderMutationError(
        "Only sent envelopes can receive reminders.",
        409,
      );
    }

    // Checked again under the lock: the envelope may have been sent for
    // another app to sign since the early check, and a reminder would
    // retire the link that app holds.
    if (persistedEnvelope.delivery === "embedded") {
      throw new ReminderMutationError(
        "This envelope is signed in another app, so SignuDoc does not email its signers.",
        409,
      );
    }

    // The deadline may have been moved since the link was issued. From
    // here on it cannot be: the envelope's row is locked.
    if (persistedEnvelope.expiresAt !== envelope.expiresAt) {
      throw new ReminderMutationError(
        "This envelope's deadline just changed. Try again.",
        409,
      );
    }

    // The same signer as the one read above: the first waiting one may be
    // another by now, if this one signed meanwhile.
    const persistedSigner = await getCurrentSignerForEnvelope(
      envelopeId,
      tx,
      signer.id,
    );

    if (!persistedSigner) {
      throw new ReminderMutationError(
        "This envelope is no longer waiting on a signer.",
        409,
      );
    }

    if (request.kind === "automatic") {
      const obstacle = getAutomaticReminderObstacle(
        persistedEnvelope,
        persistedSigner,
        dispatchedAt,
      );

      if (obstacle) {
        throw new ReminderMutationError(obstacle, 409);
      }
    } else if (typeof persistedSigner.lastNudgedAt === "number") {
      const nextAvailableAt = getManualNudgeAvailableAt(
        persistedSigner.lastNudgedAt,
      );

      if (nextAvailableAt > dispatchedAt) {
        throw new ReminderMutationError(
          `You can send another reminder after ${formatReminderAvailableAt(nextAvailableAt)}.`,
          429,
          {
            nextAvailableAt,
            nextAvailableAtLabel: formatReminderAvailableAt(nextAvailableAt),
          },
        );
      }
    }

    await tx.query(
      `
        UPDATE envelopes
        SET updated_at = $1
        WHERE id = $2
          AND status = 'sent'
      `,
      [dispatchedAt, envelopeId],
    );

    const signerUpdate = await tx.query(
      `
        UPDATE signers
        SET
          signing_token_hash = $1,
          signing_token_expires_at = $2,
          last_notified_at = $3,
          last_nudged_at = $4,
          updated_at = $5
        WHERE id = $6
          AND envelope_id = $7
          AND status = 'notified'
      `,
      [
        issuedLink.tokenHash,
        issuedLink.exp,
        dispatchedAt,
        dispatchedAt,
        dispatchedAt,
        persistedSigner.id,
        envelopeId,
      ],
    );

    if (signerUpdate.rowCount !== 1) {
      throw new ReminderMutationError(
        "This envelope is no longer waiting on a signer.",
        409,
      );
    }

    const signerMetadata = {
      signerEmail: persistedSigner.email,
      signerId: persistedSigner.id,
      signerName: persistedSigner.name,
      signerOrder: persistedSigner.signOrder,
    };
    const auditEvent = await recordAuditEvent(
      request.kind === "manual"
        ? {
            actorEmail: request.senderEmail,
            actorType: "sender",
            createdAt: dispatchedAt,
            envelopeId,
            event: "reminded_manual",
            ipAddress: request.ipAddress ?? null,
            metadata: signerMetadata,
            userAgent: request.userAgent ?? null,
          }
        : {
            actorType: "system",
            createdAt: dispatchedAt,
            envelopeId,
            event: "reminded_auto",
            metadata: {
              ...signerMetadata,
              intervalDays: persistedEnvelope.reminderIntervalDays,
            },
          },
      tx,
    );

    return {
      auditEventId: auditEvent.id,
      envelopeExpiresAt: persistedEnvelope.expiresAt,
      envelopeId,
      envelopeTitle: persistedEnvelope.title,
      issuedLink,
      nextAvailableAt: getManualNudgeAvailableAt(dispatchedAt),
      previousEnvelopeUpdatedAt: persistedEnvelope.updatedAt,
      previousSigner: {
        id: persistedSigner.id,
        lastNotifiedAt: persistedSigner.lastNotifiedAt,
        lastNudgedAt: persistedSigner.lastNudgedAt,
        signingTokenExpiresAt: persistedSigner.signingTokenExpiresAt,
        signingTokenHash: persistedSigner.signingTokenHash,
        updatedAt: persistedSigner.updatedAt,
      },
      senderName:
        request.kind === "manual"
          ? request.senderName
          : persistedEnvelope.ownerName?.trim() || persistedEnvelope.ownerEmail,
      signerEmail: persistedSigner.email,
      signerId: persistedSigner.id,
      signerName: persistedSigner.name,
      signerRole: persistedSigner.role === "approver" ? "approver" : "signer",
      userId: persistedEnvelope.userId,
    };
  }, database);
}

/**
 * Sends the reminder that was just written to the database. If the email
 * fails, the database is put back as it was and the error is passed on.
 */
async function deliverReminder(
  persisted: PersistedReminder,
  kind: ReminderRequest["kind"],
  database: DbPool,
  emailService: EmailService,
): Promise<void> {
  const template = kind === "automatic" ? "automatic_reminder" : "manual_nudge";
  let reminderMessageId: string | undefined;

  try {
    reminderMessageId = (
      await emailService.send(
        buildReminderEmail({
          branding: await getBranding(),
          envelopeId: persisted.envelopeId,
          envelopeTitle: persisted.envelopeTitle,
          expiresAt: persisted.envelopeExpiresAt,
          kind,
          senderName: persisted.senderName,
          signerEmail: persisted.signerEmail,
          signerName: persisted.signerName,
          signerRole: persisted.signerRole,
          signingUrl: persisted.issuedLink.url,
        }),
      )
    ).messageId;
  } catch (error) {
    await withTransaction(async (tx) => {
      await tx.query(
        `
          UPDATE envelopes
          SET updated_at = $1
          WHERE id = $2
            AND user_id = $3
            AND status = 'sent'
        `,
        [
          persisted.previousEnvelopeUpdatedAt,
          persisted.envelopeId,
          persisted.userId,
        ],
      );

      await tx.query(
        `
          UPDATE signers
          SET
            signing_token_hash = $1,
            -- The old link gets its old end back, unless the sender moved
            -- the deadline while the email was failing: then the link
            -- already ends at the new deadline, and keeps it.
            signing_token_expires_at = CASE
              WHEN signing_token_expires_at = $8 THEN $2
              ELSE signing_token_expires_at
            END,
            last_notified_at = $3,
            last_nudged_at = $4,
            updated_at = $5
          WHERE id = $6
            AND envelope_id = $7
            AND status = 'notified'
            -- Only while the link is still this reminder's. If the sender
            -- corrected the signer while the email was failing, the row now
            -- holds the corrected person's link, and the old one must stay
            -- dead.
            AND signing_token_hash = $9
        `,
        [
          persisted.previousSigner.signingTokenHash,
          persisted.previousSigner.signingTokenExpiresAt,
          persisted.previousSigner.lastNotifiedAt,
          persisted.previousSigner.lastNudgedAt,
          persisted.previousSigner.updatedAt,
          persisted.previousSigner.id,
          persisted.envelopeId,
          persisted.issuedLink.exp,
          persisted.issuedLink.tokenHash,
        ],
      );

      await lockEnvelopeAuditChain(persisted.envelopeId, tx);
      await tx.query(
        `
          DELETE FROM audit_events
          WHERE envelope_id = $1
            AND id = $2
            -- Only while it is still the newest link of the audit chain: an
            -- event recorded after it (say, the invitation was opened before
            -- the send failed) chains to it, so it stays as history.
            AND sequence = (
              SELECT max(sequence) FROM audit_events WHERE envelope_id = $1
            )
        `,
        [persisted.envelopeId, persisted.auditEventId],
      );
    }, database).catch((rollbackError) => {
      console.error(
        `Failed to roll back a reminder for envelope ${persisted.envelopeId} after email delivery failure:`,
        rollbackError,
      );
    });

    throw error;
  }

  await recordEmailSent(
    {
      envelopeId: persisted.envelopeId,
      messageId: reminderMessageId,
      recipient: persisted.signerEmail,
      signerId: persisted.signerId,
      template,
    },
    database,
  );
}

export async function sendManualEnvelopeNudge(
  userId: string,
  envelopeId: string,
  input: ManualNudgeInput,
  {
    database = getDb(),
    emailService,
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: SendReminderOptions = {},
) {
  // Its signers sign in another app, which reminds them itself. A reminder
  // would also retire the link that app holds.
  if (await isEmbeddedEnvelope(envelopeId, database, userId)) {
    throw new ReminderMutationError(
      "This envelope is signed in another app, so SignuDoc does not email its signers.",
      409,
    );
  }

  // Before the reminder is saved: saving retires the signer's current link,
  // so with no email to carry the new one the signer would be left with none.
  let service: EmailService;

  try {
    service = emailService ?? createEmailService();
  } catch (error) {
    if (isEmailNotConnectedError(error)) {
      throw new ReminderMutationError(EMAIL_NOT_CONNECTED_MESSAGE, 503);
    }

    throw error;
  }

  // Every signer whose turn it is and whose last reminder is far enough
  // back. With nobody waiting, or an envelope that is not this sender's,
  // the one attempt with no signer named says why.
  const waitingSignerIds = await listWaitingSignerIds(envelopeId, database);
  const targets: (string | null)[] =
    waitingSignerIds.length > 0 ? waitingSignerIds : [null];
  const reminded: PersistedReminder[] = [];
  let refusal: ReminderMutationError | null = null;
  let deliveryError: unknown = null;

  for (const signerId of targets) {
    let persisted: PersistedReminder;

    try {
      persisted = await persistReminder(
        envelopeId,
        { ...input, kind: "manual", userId },
        nowUnixTimestamp,
        database,
        signerId,
      );
    } catch (error) {
      if (!(error instanceof ReminderMutationError)) {
        throw error;
      }

      // Kept to explain why nothing was sent. Of two waits, the shorter.
      if (
        refusal === null ||
        (error.nextAvailableAt !== null &&
          (refusal.nextAvailableAt === null ||
            error.nextAvailableAt < refusal.nextAvailableAt))
      ) {
        refusal = error;
      }

      continue;
    }

    try {
      await deliverReminder(persisted, "manual", database, service);
      reminded.push(persisted);
    } catch (error) {
      // Put back as it was by deliverReminder. The others still go, and
      // the sender is told only who was reminded, so this one is logged.
      console.error(
        `Failed to send the reminder for envelope ${envelopeId} to signer ${persisted.signerId}:`,
        error,
      );
      deliveryError ??= error;
    }
  }

  const first = reminded[0];

  if (!first) {
    throw (
      deliveryError ??
      refusal ??
      new ReminderMutationError(
        "This envelope is no longer waiting on a signer.",
        409,
      )
    );
  }

  const names = reminded.map((entry) => entry.signerName);

  return manualNudgeResponseSchema.parse({
    envelopeId: first.envelopeId,
    nextAvailableAt: first.nextAvailableAt,
    nextAvailableAtLabel: formatReminderAvailableAt(first.nextAvailableAt),
    sentAt: nowUnixTimestamp,
    signerId: first.signerId,
    signerName:
      names.length === 1
        ? first.signerName
        : `${first.signerName.slice(0, 120)} and ${String(names.length - 1)} more`,
  });
}

/**
 * The daily job's reminder to the signer whose turn it is. Like the
 * sender's own reminder, it carries a new link and retires the old one.
 *
 * Returns false, having sent nothing, when the envelope no longer needs
 * one: it was signed, voided or expired, reminders were turned off, or a
 * reminder went out since the job listed it.
 */
export async function sendAutomaticEnvelopeReminder(
  envelopeId: string,
  {
    database = getDb(),
    emailService,
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
    signerId,
  }: SendReminderOptions & {
    /** One waiting signer. Left out: each waiting signer who is due. */
    signerId?: string;
  } = {},
): Promise<boolean> {
  if (await isEmbeddedEnvelope(envelopeId, database)) {
    return false;
  }

  const targets = signerId
    ? [signerId]
    : await listWaitingSignerIds(envelopeId, database);
  let sent = false;

  for (const target of targets) {
    let persisted: PersistedReminder;

    try {
      persisted = await persistReminder(
        envelopeId,
        { kind: "automatic" },
        nowUnixTimestamp,
        database,
        target,
      );
    } catch (error) {
      if (error instanceof ReminderMutationError) {
        continue;
      }

      throw error;
    }

    await deliverReminder(
      persisted,
      "automatic",
      database,
      emailService ?? createEmailService(),
    );

    sent = true;
  }

  return sent;
}
