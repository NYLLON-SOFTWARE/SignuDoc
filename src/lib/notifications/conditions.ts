import type { DbExecutor } from "../db/connection.ts";

// What the notifications job notices on its own, as opposed to what the
// audit trail records: an envelope whose deadline is a few days away, and
// an envelope nobody has done anything with for a number of days. Each is
// queued as an event like any other, under a key that makes it happen once:
//
// * envelope_expiring_soon:<envelope>:<deadline>: once per deadline, so a
//   deadline that is moved and comes close again is announced again.
// * envelope_expired:<envelope>:<deadline>: once per deadline that passed
//   with signatures missing, whether or not the email telling the sender
//   went out.
// * envelope_stuck:<envelope>: once per envelope still open for signing.
//
// "Activity" is anything in the envelope's audit trail except the emails
// and reminders the app itself sent.

const DAY = 24 * 60 * 60;
/**
 * Only envelopes sent within this long are looked at for "no activity", so
 * turning notifications on does not announce every forgotten envelope.
 */
const STUCK_LOOKBACK_SECONDS = 90 * DAY;
/**
 * Only deadlines passed within this long are announced, so turning
 * notifications on does not announce every envelope that ever expired.
 */
const EXPIRED_LOOKBACK_SECONDS = 7 * DAY;
/**
 * Audit events that are not activity: the emails and reminders the app
 * itself sent.
 */
export const NOT_ACTIVITY_EVENTS = [
  "email_sent",
  "reminded_auto",
  "reminded_manual",
] as const;

export type ConditionSummary = {
  expired: number;
  expiringSoon: number;
  stuck: number;
};

export async function queueConditionEvents(
  database: DbExecutor,
  {
    expiringDays,
    now,
    stuckDays,
  }: { expiringDays: number; now: number; stuckDays: number },
): Promise<ConditionSummary> {
  const summary: ConditionSummary = {
    expired: 0,
    expiringSoon: 0,
    stuck: 0,
  };

  // An envelope keeps the status "sent" when its deadline passes.
  const expired = await database.query(
    `
      INSERT INTO notification_events (
        id, dedupe_key, source, event, envelope_id, payload, created_at
      )
      SELECT
        gen_random_uuid()::text,
        'envelope_expired:' || e.id || ':' || e.expires_at::text,
        'job',
        'envelope_expired',
        e.id,
        jsonb_build_object('expiresAt', e.expires_at),
        $1::bigint
      FROM envelopes e
      WHERE e.status = 'sent'
        AND e.expires_at IS NOT NULL
        AND e.expires_at <= $1::bigint
        AND e.expires_at > $2::bigint
      ON CONFLICT (dedupe_key) DO NOTHING
    `,
    [now, now - EXPIRED_LOOKBACK_SECONDS],
  );

  summary.expired = expired.rowCount ?? 0;

  if (expiringDays > 0) {
    const result = await database.query(
      `
        INSERT INTO notification_events (
          id, dedupe_key, source, event, envelope_id, payload, created_at
        )
        SELECT
          gen_random_uuid()::text,
          'envelope_expiring_soon:' || e.id || ':' || e.expires_at::text,
          'job',
          'envelope_expiring_soon',
          e.id,
          jsonb_build_object('expiresAt', e.expires_at),
          $1::bigint
        FROM envelopes e
        WHERE e.status = 'sent'
          AND e.expires_at IS NOT NULL
          AND e.expires_at > $1::bigint
          AND e.expires_at <= $2::bigint
          -- Not for an envelope sent with a deadline that close already.
          AND e.sent_at IS NOT NULL
          AND e.sent_at <= $3::bigint
        ON CONFLICT (dedupe_key) DO NOTHING
      `,
      [now, now + expiringDays * DAY, now - DAY],
    );

    summary.expiringSoon = result.rowCount ?? 0;
  }

  if (stuckDays > 0) {
    const since = now - stuckDays * DAY;
    const result = await database.query(
      `
        INSERT INTO notification_events (
          id, dedupe_key, source, event, envelope_id, payload, created_at
        )
        SELECT
          gen_random_uuid()::text,
          'envelope_stuck:' || e.id,
          'job',
          'envelope_stuck',
          e.id,
          jsonb_build_object('idleDays', $3::int),
          $1::bigint
        FROM envelopes e
        WHERE e.status = 'sent'
          -- Past its deadline it is not waiting on anyone: it expired.
          AND (e.expires_at IS NULL OR e.expires_at > $1::bigint)
          AND e.sent_at IS NOT NULL
          AND e.sent_at <= $2::bigint
          AND e.sent_at >= $4::bigint
          AND NOT EXISTS (
            SELECT 1 FROM audit_events a
            WHERE a.envelope_id = e.id
              AND a.created_at > $2::bigint
              AND a.event <> ALL($5::text[])
          )
        ON CONFLICT (dedupe_key) DO NOTHING
      `,
      [
        now,
        since,
        stuckDays,
        now - STUCK_LOOKBACK_SECONDS,
        [...NOT_ACTIVITY_EVENTS],
      ],
    );

    summary.stuck = result.rowCount ?? 0;
  }

  return summary;
}
