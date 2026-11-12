import { type Branding } from "./branding.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import {
  manualNudgeResponseSchema,
  type EnvelopeRecord,
} from "./schemas/envelope.ts";
import { type SignerRecord } from "./schemas/signer.ts";
import { getBranding } from "./settings.ts";
import { recordAuditEvent } from "./services/audit.ts";
import { createEmailService } from "./services/email.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import {
  formatReminderAvailableAt,
  getManualNudgeAvailableAt,
} from "./services/reminders.ts";
import {
  issueSigningLink,
  type IssuedSigningLink,
} from "./services/signing-links.ts";
import { escapeHtml } from "./utils/html.ts";

type ReminderEnvelopeRow = {
  id: string;
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

type PersistedManualNudge = {
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
  senderName: string;
};

type SendManualEnvelopeNudgeOptions = {
  database?: DbPool;
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

async function getEnvelopeByIdForUser(
  envelopeId: string,
  userId: string,
  database: DbExecutor,
): Promise<ReminderEnvelopeRow | null> {
  return queryOne<ReminderEnvelopeRow>(
    database,
    `
      SELECT
        id,
        user_id AS "userId",
        title,
        status,
        updated_at AS "updatedAt"
      FROM envelopes
      WHERE id = $1
        AND user_id = $2
    `,
    [envelopeId, userId],
  );
}

async function getCurrentSignerForEnvelope(
  envelopeId: string,
  database: DbExecutor,
): Promise<ReminderSignerRow | null> {
  return queryOne<ReminderSignerRow>(
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
        last_notified_at AS "lastNotifiedAt",
        last_nudged_at AS "lastNudgedAt",
        updated_at AS "updatedAt"
      FROM signers
      WHERE envelope_id = $1
        AND status = 'notified'
      ORDER BY sign_order ASC, id ASC
      LIMIT 1
    `,
    [envelopeId],
  );
}

function buildReminderEmail(input: {
  branding: Branding;
  envelopeId: string;
  envelopeTitle: string;
  senderName: string;
  signerEmail: string;
  signerName: string;
  signingUrl: string;
}) {
  const subject = `${input.senderName} sent you a reminder to sign "${input.envelopeTitle}"`;
  const introLine = `${input.senderName} sent you a reminder to sign "${input.envelopeTitle}" through ${input.branding.productName}.`;
  const textBody = [
    `Hi ${input.signerName},`,
    "",
    introLine,
    "",
    "Review and sign the document here:",
    input.signingUrl,
    "",
    `You do not need a ${input.branding.productName} account to sign.`,
    "If you receive a newer invitation or reminder link, use the newest one.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.signerName)},</p>`,
    `<p>${escapeHtml(introLine)}</p>`,
    `<p><a href="${escapeHtml(input.signingUrl)}">Review and sign the document</a></p>`,
    `<p>You do not need a ${escapeHtml(input.branding.productName)} account to sign.</p>`,
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
    template: "manual_nudge" as const,
    textBody: legalFooter.textBody,
    to: input.signerEmail,
  };
}

async function persistManualNudge(
  userId: string,
  envelopeId: string,
  input: ManualNudgeInput,
  dispatchedAt: number,
  database: DbPool,
): Promise<PersistedManualNudge> {
  const envelope = await getEnvelopeByIdForUser(envelopeId, userId, database);

  if (!envelope) {
    throw new ReminderMutationError("This envelope is unavailable.", 404);
  }

  if (envelope.status !== "sent") {
    throw new ReminderMutationError(
      "Only sent envelopes can receive reminders.",
      409,
    );
  }

  const signer = await getCurrentSignerForEnvelope(envelopeId, database);

  if (!signer) {
    throw new ReminderMutationError(
      "This envelope is no longer waiting on a signer.",
      409,
    );
  }

  const issuedLink = await issueSigningLink({
    issuedAt: dispatchedAt,
  });
  return withTransaction(async (tx) => {
    const persistedEnvelope = await getEnvelopeByIdForUser(
      envelopeId,
      userId,
      tx,
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

    const persistedSigner = await getCurrentSignerForEnvelope(envelopeId, tx);

    if (!persistedSigner) {
      throw new ReminderMutationError(
        "This envelope is no longer waiting on a signer.",
        409,
      );
    }

    if (typeof persistedSigner.lastNudgedAt === "number") {
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
          AND user_id = $3
          AND status = 'sent'
      `,
      [dispatchedAt, envelopeId, userId],
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

    await recordAuditEvent(
      {
        actorEmail: input.senderEmail,
        actorType: "sender",
        createdAt: dispatchedAt,
        envelopeId,
        event: "reminded_manual",
        ipAddress: input.ipAddress ?? null,
        metadata: {
          signerEmail: persistedSigner.email,
          signerId: persistedSigner.id,
          signerName: persistedSigner.name,
          signerOrder: persistedSigner.signOrder,
        },
        userAgent: input.userAgent ?? null,
      },
      tx,
    );

    return {
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
      senderName: input.senderName,
      signerEmail: persistedSigner.email,
      signerId: persistedSigner.id,
      signerName: persistedSigner.name,
    };
  }, database);
}

export async function sendManualEnvelopeNudge(
  userId: string,
  envelopeId: string,
  input: ManualNudgeInput,
  {
    database = getDb(),
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: SendManualEnvelopeNudgeOptions = {},
) {
  const persisted = await persistManualNudge(
    userId,
    envelopeId,
    input,
    nowUnixTimestamp,
    database,
  );
  const emailService = createEmailService();

  try {
    await emailService.send(
      buildReminderEmail({
        branding: await getBranding(),
        envelopeId: persisted.envelopeId,
        envelopeTitle: persisted.envelopeTitle,
        senderName: persisted.senderName,
        signerEmail: persisted.signerEmail,
        signerName: persisted.signerName,
        signingUrl: persisted.issuedLink.url,
      }),
    );
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
        [persisted.previousEnvelopeUpdatedAt, persisted.envelopeId, userId],
      );

      await tx.query(
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
          persisted.previousSigner.signingTokenHash,
          persisted.previousSigner.signingTokenExpiresAt,
          persisted.previousSigner.lastNotifiedAt,
          persisted.previousSigner.lastNudgedAt,
          persisted.previousSigner.updatedAt,
          persisted.previousSigner.id,
          persisted.envelopeId,
        ],
      );

      await tx.query(
        `
          DELETE FROM audit_events
          WHERE envelope_id = $1
            AND event = 'reminded_manual'
            AND created_at = $2
            AND actor_email = $3
        `,
        [persisted.envelopeId, nowUnixTimestamp, input.senderEmail],
      );
    }, database).catch((rollbackError) => {
      console.error(
        `Failed to roll back manual reminder for envelope ${persisted.envelopeId} after email delivery failure:`,
        rollbackError,
      );
    });

    throw error;
  }

  return manualNudgeResponseSchema.parse({
    envelopeId: persisted.envelopeId,
    nextAvailableAt: persisted.nextAvailableAt,
    nextAvailableAtLabel: formatReminderAvailableAt(persisted.nextAvailableAt),
    sentAt: nowUnixTimestamp,
    signerId: persisted.signerId,
    signerName: persisted.signerName,
  });
}
