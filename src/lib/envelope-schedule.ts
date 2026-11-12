import { type DbPool, queryMany, withTransaction } from "./db/connection.ts";
import { formatDeadline } from "./envelope-deadline.ts";
import { lockEnvelopeAuditChain, recordAuditEvent } from "./services/audit.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import { resolveAppUrl } from "./utils/env.ts";

// What the daily job does for envelopes that are out for signature: it tells
// a sender once when a deadline has passed with signatures still missing.
//
// It runs from the same cron call as the cleanup (see retention-job.ts), so
// an install needs no second schedule. Each envelope is claimed in the
// database before its email goes out, and the claim is given back if the
// email fails, so a failed run is retried the next day and a second run
// never sends twice.

const BATCH_SIZE = 200;

export type EnvelopeScheduleSummary = {
  expiryNoticeFailures: string[];
  expiryNoticesSent: number;
};

type ExpiredEnvelopeRow = {
  expiresAt: number;
  id: string;
  ownerEmail: string;
  ownerName: string | null;
  signerEmail: string | null;
  signerName: string | null;
  title: string;
};

async function listExpiredEnvelopesToNotify(
  now: number,
  database: DbPool,
): Promise<ExpiredEnvelopeRow[]> {
  return queryMany<ExpiredEnvelopeRow>(
    database,
    `
      SELECT
        e.id,
        e.title,
        e.expires_at AS "expiresAt",
        u.email AS "ownerEmail",
        u.name AS "ownerName",
        s.name AS "signerName",
        s.email AS "signerEmail"
      FROM envelopes e
      JOIN "user" u ON u.id = e.user_id
      LEFT JOIN signers s
        ON s.envelope_id = e.id
        AND s.status = 'notified'
      WHERE e.status = 'sent'
        AND e.expires_at IS NOT NULL
        AND e.expires_at <= $1
        AND e.expiry_notified_at IS NULL
      ORDER BY e.expires_at ASC, e.id ASC
      LIMIT ${BATCH_SIZE}
    `,
    [now],
  );
}

/**
 * Marks the envelope as told and notes the passed deadline in its audit
 * trail. False when there is nothing to tell any more: the sender moved the
 * deadline, the envelope was finished or voided, or another run got here.
 */
async function claimExpiryNotice(
  envelope: ExpiredEnvelopeRow,
  now: number,
  database: DbPool,
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const claimed = await tx.query(
      `
        UPDATE envelopes
        SET expiry_notified_at = $1
        WHERE id = $2
          AND status = 'sent'
          AND expires_at = $3
          AND expiry_notified_at IS NULL
      `,
      [now, envelope.id, envelope.expiresAt],
    );

    if (claimed.rowCount !== 1) {
      return false;
    }

    await recordAuditEvent(
      {
        actorType: "system",
        createdAt: now,
        envelopeId: envelope.id,
        event: "expired",
        metadata: { expiresAt: envelope.expiresAt },
      },
      tx,
    );

    return true;
  }, database);
}

/** Gives a claim back after its email failed, so the next run tries again. */
async function releaseExpiryNotice(
  envelope: ExpiredEnvelopeRow,
  now: number,
  database: DbPool,
): Promise<void> {
  await withTransaction(async (tx) => {
    await lockEnvelopeAuditChain(envelope.id, tx);

    const removed = await tx.query(
      `
        DELETE FROM audit_events
        WHERE envelope_id = $1
          AND event = 'expired'
          AND created_at = $2
          -- Only while it is still the newest link of the audit chain.
          AND sequence = (
            SELECT max(sequence) FROM audit_events WHERE envelope_id = $1
          )
      `,
      [envelope.id, now],
    );

    // An event chained after it keeps the note in place, and then the
    // envelope stays marked: the trail must not say "expired" twice.
    if (removed.rowCount === 1) {
      await tx.query(
        `
          UPDATE envelopes
          SET expiry_notified_at = NULL
          WHERE id = $1 AND expiry_notified_at = $2
        `,
        [envelope.id, now],
      );
    }
  }, database);
}

function buildExpiryNotice(envelope: ExpiredEnvelopeRow) {
  const appUrl = resolveAppUrl();
  const link = appUrl ? `${appUrl}/envelopes/${envelope.id}` : null;
  const waitingOn =
    envelope.signerName && envelope.signerEmail
      ? ` It was still waiting on ${envelope.signerName} (${envelope.signerEmail}).`
      : "";

  return {
    subject: `"${envelope.title}" expired before everyone signed`,
    template: "expiry_notice" as const,
    textBody: [
      `Hello ${envelope.ownerName?.trim() || envelope.ownerEmail},`,
      "",
      `The deadline for "${envelope.title}" passed on ${formatDeadline(envelope.expiresAt)}.${waitingOn} Nobody can sign it now.`,
      "",
      "To give signers more time, open the envelope and set a new deadline. The signing link that was already sent will work again. If the document is no longer needed, void it.",
      ...(link ? ["", link] : []),
    ].join("\n"),
    to: envelope.ownerEmail,
  };
}

async function sendExpiryNotices(
  now: number,
  database: DbPool,
  emailService: () => EmailService,
  summary: EnvelopeScheduleSummary,
): Promise<void> {
  const expired = await listExpiredEnvelopesToNotify(now, database);

  for (const envelope of expired) {
    try {
      if (!(await claimExpiryNotice(envelope, now, database))) {
        continue;
      }

      try {
        await emailService().send(buildExpiryNotice(envelope), {
          idempotencyKey: `expiry-notice/${envelope.id}/${envelope.expiresAt}`,
        });
      } catch (error) {
        await releaseExpiryNotice(envelope, now, database).catch(
          (releaseError: unknown) => {
            console.error(
              `Failed to give back the expiry notice claim for envelope ${envelope.id}:`,
              releaseError,
            );
          },
        );

        throw error;
      }

      summary.expiryNoticesSent += 1;
    } catch (error) {
      summary.expiryNoticeFailures.push(envelope.id);
      console.error(`Expiry notice failed for envelope ${envelope.id}:`, error);
    }
  }
}

export async function runEnvelopeSchedule({
  database,
  emailService,
  now = Math.floor(Date.now() / 1000),
}: {
  database: DbPool;
  emailService?: EmailService;
  now?: number;
}): Promise<EnvelopeScheduleSummary> {
  const summary: EnvelopeScheduleSummary = {
    expiryNoticeFailures: [],
    expiryNoticesSent: 0,
  };
  let service = emailService;
  // Made only when there is something to send: an install without email
  // set up yet must not fail the whole job.
  const getEmailService = () => (service ??= createEmailService());

  await sendExpiryNotices(now, database, getEmailService, summary);

  return summary;
}

export function envelopeScheduleFailed(
  summary: EnvelopeScheduleSummary,
): boolean {
  return summary.expiryNoticeFailures.length > 0;
}
