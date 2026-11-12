import {
  DEFAULT_ENVELOPE_DEADLINE_DAYS,
  MAX_ENVELOPE_DEADLINE_DAYS,
  SIGNING_LINK_TTL_SECONDS,
} from "./types/domain.ts";

// The deadline of an envelope: the moment after which nobody can sign it.
//
// The sender picks a number of days when sending and can change it while the
// envelope is out. Every signing link of the envelope expires at the
// deadline, whenever the link was issued. A sent envelope whose deadline has
// passed is shown as expired; it is still "sent" underneath, so setting a
// later deadline brings it back.

const SECONDS_PER_DAY = 24 * 60 * 60;

export class EnvelopeDeadlinePassedError extends Error {
  readonly expiresAt: number;

  constructor(expiresAt: number) {
    super(
      `This request expired on ${formatDeadline(expiresAt)}. Set a new deadline first.`,
    );
    this.name = "EnvelopeDeadlinePassedError";
    this.expiresAt = expiresAt;
  }
}

/** A whole number of days from 1 to the maximum, or null when it is not one. */
export function parseDeadlineDays(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_ENVELOPE_DEADLINE_DAYS
    ? value
    : null;
}

export function deadlineFromDays(
  nowUnixTimestamp: number,
  days: number = DEFAULT_ENVELOPE_DEADLINE_DAYS,
): number {
  return nowUnixTimestamp + days * SECONDS_PER_DAY;
}

/** True for an envelope that is out for signature and past its deadline. */
export function isEnvelopeExpired(
  envelope: { expiresAt?: number | null; status: string },
  nowUnixTimestamp: number,
): boolean {
  return (
    envelope.status === "sent" &&
    typeof envelope.expiresAt === "number" &&
    envelope.expiresAt <= nowUnixTimestamp
  );
}

/**
 * How long a signing link issued now should live. It ends at the envelope's
 * deadline. An envelope without one (sent before deadlines existed) keeps
 * the old seven days per link.
 */
export function signingLinkLifetimeSeconds(
  envelopeExpiresAt: number | null | undefined,
  issuedAt: number,
): number {
  if (typeof envelopeExpiresAt !== "number") {
    return SIGNING_LINK_TTL_SECONDS;
  }

  if (envelopeExpiresAt <= issuedAt) {
    throw new EnvelopeDeadlinePassedError(envelopeExpiresAt);
  }

  return envelopeExpiresAt - issuedAt;
}

const deadlineFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

/** "December 12, 2026 at 9:20 PM UTC" */
export function formatDeadline(unixTimestamp: number): string {
  return `${deadlineFormatter
    .format(new Date(unixTimestamp * 1000))
    .replace(/[  ]/g, " ")} UTC`;
}
