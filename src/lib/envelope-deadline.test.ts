import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deadlineFromDays,
  EnvelopeDeadlinePassedError,
  formatDeadline,
  isEnvelopeExpired,
  nextSignerLinkExpiresAt,
  parseDeadlineDays,
  signingLinkLifetimeSeconds,
} from "./envelope-deadline.ts";
import { buildDeadlineLine } from "./services/signing-invitation-email.ts";
import { SIGNING_LINK_TTL_SECONDS } from "./types/domain.ts";

const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;

test("a deadline is a whole number of days from now, thirty by default", () => {
  assert.equal(deadlineFromDays(NOW), NOW + 30 * DAY);
  assert.equal(deadlineFromDays(NOW, 3), NOW + 3 * DAY);
});

test("only whole days from 1 to 365 are accepted", () => {
  assert.equal(parseDeadlineDays(14), 14);
  assert.equal(parseDeadlineDays(365), 365);

  for (const refused of [0, -1, 366, 1.5, "14", null, undefined, Number.NaN]) {
    assert.equal(parseDeadlineDays(refused), null);
  }
});

test("only an envelope out for signature can be expired", () => {
  assert.equal(
    isEnvelopeExpired({ expiresAt: NOW - 1, status: "sent" }, NOW),
    true,
  );
  // The deadline itself is the first moment it no longer counts.
  assert.equal(
    isEnvelopeExpired({ expiresAt: NOW, status: "sent" }, NOW),
    true,
  );
  assert.equal(
    isEnvelopeExpired({ expiresAt: NOW + 1, status: "sent" }, NOW),
    false,
  );
  // Sent before deadlines existed.
  assert.equal(
    isEnvelopeExpired({ expiresAt: null, status: "sent" }, NOW),
    false,
  );

  for (const status of ["draft", "completed", "declined", "voided"]) {
    assert.equal(isEnvelopeExpired({ expiresAt: NOW - 1, status }, NOW), false);
  }
});

test("a signing link lives until the envelope's deadline", () => {
  assert.equal(signingLinkLifetimeSeconds(NOW + 5 * DAY, NOW), 5 * DAY);
  assert.equal(signingLinkLifetimeSeconds(null, NOW), SIGNING_LINK_TTL_SECONDS);
  assert.throws(
    () => signingLinkLifetimeSeconds(NOW, NOW),
    EnvelopeDeadlinePassedError,
  );
});

test("the next signer's link ends at the envelope's deadline", () => {
  assert.equal(nextSignerLinkExpiresAt(NOW + 5 * DAY, NOW), NOW + 5 * DAY);
  // The deadline passed while the signer before them was submitting.
  assert.equal(nextSignerLinkExpiresAt(NOW - 5, NOW), NOW + 60);
  assert.equal(
    nextSignerLinkExpiresAt(null, NOW),
    NOW + SIGNING_LINK_TTL_SECONDS,
  );
});

test("a deadline is written out in full, in UTC", () => {
  // 2027-01-15 08:00:00 UTC
  assert.equal(
    formatDeadline(1_800_000_000),
    "January 15, 2027 at 8:00 AM UTC",
  );
  assert.equal(
    buildDeadlineLine(1_800_000_000),
    "This request expires on January 15, 2027 at 8:00 AM UTC.",
  );
  assert.equal(buildDeadlineLine(null), null);
});
