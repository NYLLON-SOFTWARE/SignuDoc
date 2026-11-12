import { MANUAL_NUDGE_COOLDOWN_SECONDS } from "../types/domain.ts";

export function getManualNudgeAvailableAt(lastNudgedAt: number): number {
  return lastNudgedAt + MANUAL_NUDGE_COOLDOWN_SECONDS;
}

export function isManualNudgeAvailable(
  lastNudgedAt: number | null | undefined,
  nowUnixTimestamp: number,
): boolean {
  if (typeof lastNudgedAt !== "number") {
    return true;
  }

  return getManualNudgeAvailableAt(lastNudgedAt) <= nowUnixTimestamp;
}

const reminderAvailabilityFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "long",
});

const SECONDS_PER_DAY = 24 * 60 * 60;

/** "Off", "Every day", "Every 3 days", "Every week". */
export function formatReminderInterval(intervalDays: number | null): string {
  if (intervalDays === null) {
    return "Off";
  }

  if (intervalDays === 1) {
    return "Every day";
  }

  return intervalDays === 7
    ? "Every week"
    : `Every ${String(intervalDays)} days`;
}

/**
 * The daily job runs once a day at a fixed hour, so "every N days" is read
 * with half a day of slack: a reminder is due once N days less twelve hours
 * have passed. Without it, an envelope sent an hour after the job ran would
 * wait a whole extra day every time.
 */
export const AUTOMATIC_REMINDER_SLACK_SECONDS = 12 * 60 * 60;

/** The moment from which the daily job may send the next reminder. */
export function getAutomaticReminderDueAt(
  lastContactAt: number,
  intervalDays: number,
): number {
  return (
    lastContactAt +
    intervalDays * SECONDS_PER_DAY -
    AUTOMATIC_REMINDER_SLACK_SECONDS
  );
}

/**
 * True when the signer has heard nothing, neither an invitation nor any
 * kind of reminder, for the envelope's reminder interval.
 */
export function isAutomaticReminderDue(
  {
    intervalDays,
    lastNotifiedAt,
    lastNudgedAt,
  }: {
    intervalDays: number;
    lastNotifiedAt: number | null | undefined;
    lastNudgedAt: number | null | undefined;
  },
  nowUnixTimestamp: number,
): boolean {
  const lastContactAt = Math.max(lastNotifiedAt ?? 0, lastNudgedAt ?? 0);

  // Never contacted means there is no invitation to follow up on.
  if (lastContactAt === 0) {
    return false;
  }

  return (
    getAutomaticReminderDueAt(lastContactAt, intervalDays) <= nowUnixTimestamp
  );
}

export function formatReminderAvailableAt(unixTimestamp: number): string {
  return reminderAvailabilityFormatter.format(new Date(unixTimestamp * 1000));
}
