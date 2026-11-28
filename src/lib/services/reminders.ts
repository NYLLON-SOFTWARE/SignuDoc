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

export const FIXED_REMINDER_SCHEDULE = "days_3_and_7";
export type FixedReminderSchedule = typeof FIXED_REMINDER_SCHEDULE;
export type ReminderSelection = number | FixedReminderSchedule | null;

/** "Off", "Every day", "Every 3 days", "Every week". */
export function formatReminderInterval(
  intervalDays: ReminderSelection,
): string {
  if (intervalDays === null) {
    return "Off";
  }

  if (intervalDays === FIXED_REMINDER_SCHEDULE) {
    return "On days 3 and 7";
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

export function parseReminderSelection(value: string): ReminderSelection {
  if (value === "off") {
    return null;
  }

  return value === FIXED_REMINDER_SCHEDULE ? value : Number(value);
}

export function reminderSelectionOptions(selection: ReminderSelection) {
  return {
    reminderIntervalDays: typeof selection === "number" ? selection : null,
    reminderSchedule: selection === FIXED_REMINDER_SCHEDULE ? selection : null,
  };
}

/** Choose the latest due milestone, so a missed run never sends two together. */
export function getFixedReminderDay(
  turnStartedAt: number | null,
  lastSentDay: number | null,
  now: number,
): 3 | 7 | null {
  if (turnStartedAt === null) {
    return null;
  }

  const daysWaiting = (now - turnStartedAt) / SECONDS_PER_DAY;

  if (daysWaiting >= 7 && (lastSentDay ?? 0) < 7) {
    return 7;
  }

  return daysWaiting >= 3 && lastSentDay === null ? 3 : null;
}

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
