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

export function formatReminderAvailableAt(unixTimestamp: number): string {
  return reminderAvailabilityFormatter.format(new Date(unixTimestamp * 1000));
}
