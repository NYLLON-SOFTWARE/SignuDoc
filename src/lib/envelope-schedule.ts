import {
  type DbPool,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { canAccessEnvelopeFolderCondition } from "./envelope-access.ts";
import { formatDeadline } from "./envelope-deadline.ts";
import { sendAutomaticEnvelopeReminder } from "./reminders.ts";
import { recordAuditEvent } from "./services/audit.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import { AUTOMATIC_REMINDER_SLACK_SECONDS } from "./services/reminders.ts";
import { resolveAppUrl } from "./utils/env.ts";

// What the daily job does for envelopes that are out for signature:
//
// - it tells a sender once when a deadline has passed with signatures still
//   missing;
// - it reminds the signer whose turn it is, on envelopes whose sender asked
//   for automatic reminders.
//
// It runs from the same cron call as the cleanup (see retention-job.ts), so
// an install needs no second schedule, and that call's lock means two runs
// never work at once.
//
// A notice about a passed deadline is sent first and noted afterwards. So a
// notice that did not go out, because the email failed or because the run
// was cut off, is simply still due on the next run. The cost is that a run
// cut off between the two can send the notice a second time; the mail
// provider drops a repeat that reaches it within its idempotency window.
//
// A reminder changes the signer's link, so it is saved first and undone if
// its email fails (see reminders.ts).

const BATCH_SIZE = 200;
// The job shares one function call with the cleanup, and a mail provider
// takes about half a second per message. Past this, what is left waits for
// the next run instead of risking the call being cut off mid-send.
const TIME_BUDGET_MS = 60_000;

export type EnvelopeScheduleSummary = {
  expiryNoticeFailures: string[];
  expiryNoticesSent: number;
  reminderFailures: string[];
  remindersSent: number;
  /** True when the time ran out and some envelopes wait for the next run. */
  stoppedEarly: boolean;
};

type ScheduleRun = {
  database: DbPool;
  emailService: () => EmailService;
  now: number;
  outOfTime: () => boolean;
  summary: EnvelopeScheduleSummary;
};

type ExpiredEnvelopeRow = {
  expiresAt: number;
  id: string;
  ownerEmail: string;
  ownerName: string | null;
  ownerId: string;
  /** "Name (email)" of each signer it was waiting on, or null. */
  waitingOn: string | null;
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
        e.user_id AS "ownerId",
        -- Everyone it was waiting on, in signing order: one signer, or a
        -- whole step of signers who sign at the same time.
        (
          SELECT string_agg(
            s.name || ' (' || s.email || ')',
            ', ' ORDER BY s.sign_order, s.id
          )
          FROM signers s
          WHERE s.envelope_id = e.id
            AND s.status = 'notified'
        ) AS "waitingOn"
      FROM envelopes e
      JOIN "user" u ON u.id = e.user_id
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
 * Whether there is still something to note, and whether the sender may be
 * told. The expiry is due while the envelope is out, its deadline is the one
 * that passed, and it has not been noted. The list above can be minutes old
 * by the time an envelope's turn comes, and the sender may have moved the
 * deadline or voided the envelope since. The expiry is always noted, so
 * folder members see it and integrations get `envelope.expired`; the email
 * goes to the sender only while they can still open the envelope's folder.
 */
async function checkExpiryNotice(
  envelope: ExpiredEnvelopeRow,
  database: DbPool,
): Promise<{ due: false } | { due: true; tellSender: boolean }> {
  const row = await queryOne<{ tellSender: boolean }>(
    database,
    `
      SELECT ${canAccessEnvelopeFolderCondition("$3")} AS "tellSender"
      FROM envelopes
      WHERE id = $1
        AND status = 'sent'
        AND expires_at = $2
        AND expiry_notified_at IS NULL
        AND user_id = $3
    `,
    [envelope.id, envelope.expiresAt, envelope.ownerId],
  );

  return row === null
    ? { due: false }
    : { due: true, tellSender: row.tellSender };
}

/**
 * Marks the envelope as told and notes the passed deadline in its audit
 * trail, once the notice has gone out. Nothing is noted when the sender
 * moved the deadline while the notice was on its way: the new deadline is a
 * new thing to tell.
 */
async function noteExpiryNoticeSent(
  envelope: ExpiredEnvelopeRow,
  now: number,
  database: DbPool,
): Promise<void> {
  await withTransaction(async (tx) => {
    const noted = await tx.query(
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

    if (noted.rowCount !== 1) {
      return;
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
  }, database);
}

function buildExpiryNotice(envelope: ExpiredEnvelopeRow) {
  const appUrl = resolveAppUrl();
  const link = appUrl ? `${appUrl}/envelopes/${envelope.id}` : null;
  const waitingOn = envelope.waitingOn
    ? ` It was still waiting on ${envelope.waitingOn}.`
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

async function sendExpiryNotices({
  database,
  emailService,
  now,
  outOfTime,
  summary,
}: ScheduleRun): Promise<void> {
  const expired = await listExpiredEnvelopesToNotify(now, database);

  for (const envelope of expired) {
    if (outOfTime()) {
      summary.stoppedEarly = true;
      return;
    }

    try {
      const notice = await checkExpiryNotice(envelope, database);
      if (!notice.due) {
        continue;
      }

      if (notice.tellSender) {
        await emailService().send(buildExpiryNotice(envelope), {
          idempotencyKey: `expiry-notice/${envelope.id}/${envelope.expiresAt}`,
        });
      }
      await noteExpiryNoticeSent(envelope, now, database);

      if (notice.tellSender) {
        summary.expiryNoticesSent += 1;
      }
    } catch (error) {
      summary.expiryNoticeFailures.push(envelope.id);
      console.error(`Expiry notice failed for envelope ${envelope.id}:`, error);
    }
  }
}

/**
 * Envelopes whose current signer has heard nothing for the envelope's
 * reminder interval. Expired ones are left out: their link is dead, and the
 * sender has been told.
 */
async function listSignersDueForReminder(
  now: number,
  database: DbPool,
): Promise<{ envelopeId: string; signerId: string }[]> {
  // One row for each waiting signer who is due: signers of a step that
  // signs at the same time are each reminded on their own schedule.
  return queryMany<{ envelopeId: string; signerId: string }>(
    database,
    `
      SELECT e.id AS "envelopeId", s.id AS "signerId"
      FROM envelopes e
      JOIN signers s
        ON s.envelope_id = e.id
        AND s.status = 'notified'
      WHERE e.status = 'sent'
        -- Embedded envelopes get no reminders; left out here, before the
        -- batch limit, so they cannot fill every batch.
        AND e.delivery = 'email'
        AND e.reminder_interval_days IS NOT NULL
        AND (e.expires_at IS NULL OR e.expires_at > $1)
        AND GREATEST(
          COALESCE(s.last_notified_at, 0),
          COALESCE(s.last_nudged_at, 0)
        ) > 0
        AND GREATEST(
          COALESCE(s.last_notified_at, 0),
          COALESCE(s.last_nudged_at, 0)
        ) + e.reminder_interval_days * 86400 - $2 <= $1
      ORDER BY
        GREATEST(
          COALESCE(s.last_notified_at, 0),
          COALESCE(s.last_nudged_at, 0)
        ) ASC,
        e.id ASC,
        s.id ASC
      LIMIT ${BATCH_SIZE}
    `,
    [now, AUTOMATIC_REMINDER_SLACK_SECONDS],
  );
}

async function sendAutomaticReminders({
  database,
  emailService,
  now,
  outOfTime,
  summary,
}: ScheduleRun): Promise<void> {
  for (const { envelopeId, signerId } of await listSignersDueForReminder(
    now,
    database,
  )) {
    if (outOfTime()) {
      summary.stoppedEarly = true;
      return;
    }

    try {
      const sent = await sendAutomaticEnvelopeReminder(envelopeId, {
        database,
        emailService: emailService(),
        nowUnixTimestamp: now,
        signerId,
      });

      if (sent) {
        summary.remindersSent += 1;
      }
    } catch (error) {
      summary.reminderFailures.push(envelopeId);
      console.error(
        `Automatic reminder failed for envelope ${envelopeId}:`,
        error,
      );
    }
  }
}

export async function runEnvelopeSchedule({
  database,
  emailService,
  now = Math.floor(Date.now() / 1000),
  timeBudgetMs = TIME_BUDGET_MS,
}: {
  database: DbPool;
  emailService?: EmailService;
  now?: number;
  timeBudgetMs?: number;
}): Promise<EnvelopeScheduleSummary> {
  const summary: EnvelopeScheduleSummary = {
    expiryNoticeFailures: [],
    expiryNoticesSent: 0,
    reminderFailures: [],
    remindersSent: 0,
    stoppedEarly: false,
  };
  const stopAt = Date.now() + timeBudgetMs;
  let service = emailService;
  // Made only when there is something to send: an install without email
  // set up yet must not fail the whole job.
  const getEmailService = () => (service ??= createEmailService());

  const run: ScheduleRun = {
    database,
    emailService: getEmailService,
    now,
    outOfTime: () => Date.now() >= stopAt,
    summary,
  };

  await sendExpiryNotices(run);
  await sendAutomaticReminders(run);

  return summary;
}

export function envelopeScheduleFailed(
  summary: EnvelopeScheduleSummary,
): boolean {
  return (
    summary.expiryNoticeFailures.length > 0 ||
    summary.reminderFailures.length > 0
  );
}
