import assert from "node:assert/strict";
import { test } from "node:test";

import { safeErrorCode } from "./channel.ts";
import {
  BURST_KINDS,
  IN_PLACE_KINDS,
  listNotificationEvents,
  notificationEventKinds,
  notificationKindFor,
  NOTIFICATION_EVENTS,
} from "./events.ts";
import {
  buildNotificationMessage,
  headlineText,
  readNotificationPayload,
  type NotificationEnvelope,
} from "./message.ts";
import {
  jobWarningStillHolds,
  MAX_DELIVERY_ATTEMPTS,
  placementFor,
  retryDelaySeconds,
  updateForFailure,
} from "./outbox.ts";
import {
  EMPTY_NOTIFICATION_SETTINGS,
  readNotificationThresholds,
} from "./store.ts";

// The channel-independent parts of notifications: the event model, the
// messages, and the retry schedule.

const envelope: NotificationEnvelope = {
  expiresAt: null,
  id: "env-1",
  ownerEmail: "sam@example.com",
  ownerName: "Sam Sender",
  signedCount: 1,
  signerCount: 2,
  status: "sent",
  title: "Master services agreement",
};

test("audit events map to notification kinds, and the rest are dropped", () => {
  assert.equal(notificationKindFor("audit", "sent"), "envelope_sent");
  assert.equal(notificationKindFor("audit", "viewed"), "envelope_viewed");
  assert.equal(notificationKindFor("audit", "signed"), "envelope_signed");
  assert.equal(notificationKindFor("audit", "completed"), "envelope_completed");
  assert.equal(notificationKindFor("audit", "declined"), "envelope_declined");
  assert.equal(notificationKindFor("audit", "voided"), "envelope_voided");
  // The job notices a passed deadline itself (conditions.ts).
  assert.equal(notificationKindFor("audit", "expired"), null);
  assert.equal(
    notificationKindFor("job", "envelope_expired"),
    "envelope_expired",
  );
  assert.equal(notificationKindFor("audit", "email_sent"), null);
  assert.equal(notificationKindFor("audit", "consented"), null);
  assert.equal(notificationKindFor("audit", "some_future_event"), null);
  assert.equal(notificationKindFor("job", "envelope_stuck"), "envelope_stuck");
  assert.equal(notificationKindFor("job", "backup_failed"), null);
  assert.equal(notificationKindFor("job", "signed"), null);
});

test("every kind has a definition, and the job's own kinds come from no audit event", () => {
  assert.equal(listNotificationEvents().length, notificationEventKinds.length);

  for (const kind of notificationEventKinds) {
    assert.equal(NOTIFICATION_EVENTS[kind].kind, kind);
  }

  for (const kind of [
    "envelope_expired",
    "envelope_expiring_soon",
    "envelope_stuck",
  ] as const) {
    assert.equal(NOTIFICATION_EVENTS[kind].auditEvent, null);
  }
});

test("a message says what happened, who did it, and where the envelope stands", () => {
  const message = buildNotificationMessage({
    appUrl: "https://sign.example.com/",
    envelope,
    kind: "envelope_signed",
    occurredAt: 1_900_000_000,
    payload: { signerEmail: "riley@example.com", signerName: "Riley" },
  });

  assert.equal(
    headlineText(message.headline),
    "Riley signed Master services agreement — 1 of 2 signed",
  );
  assert.deepEqual(
    message.headline.filter((part) => part.strong).map((part) => part.text),
    ["Master services agreement"],
  );
  assert.deepEqual(message.details, [
    "Out for signature",
    "Sent by Sam Sender",
  ]);
  assert.equal(message.progress, "1 of 2 signed");
  assert.equal(message.tone, "progress");
  assert.equal(message.occurredAt, 1_900_000_000);
  assert.deepEqual(message.actions, [
    {
      id: "open",
      label: "Open envelope",
      url: "https://sign.example.com/envelopes/env-1",
    },
  ]);
  assert.equal(
    message.text,
    "Riley signed Master services agreement — 1 of 2 signed · Out for signature · Sent by Sam Sender",
  );
});

test("each kind has its own headline, and none shouts", () => {
  const headlines = notificationEventKinds.map((kind) =>
    headlineText(
      buildNotificationMessage({
        appUrl: null,
        envelope,
        kind,
        payload: { expiresAt: 1_900_000_000, idleDays: 7, signerName: "Riley" },
      }).headline,
    ),
  );

  assert.equal(new Set(headlines).size, headlines.length);
  assert.ok(headlines.some((line) => /no activity for 7 days/.test(line)));
  assert.ok(headlines.some((line) => /expires on/.test(line)));
  assert.ok(headlines.every((line) => !line.includes("!")));
});

test("buttons: the certificate when complete, a reminder only for the sender", () => {
  const actionIds = (
    kind: Parameters<typeof buildNotificationMessage>[0]["kind"],
    forSender: boolean,
    status = "sent",
  ) =>
    buildNotificationMessage({
      appUrl: "https://sign.example.com",
      envelope: { ...envelope, status },
      forSender,
      kind,
      payload: {},
    }).actions.map((action) => action.id);

  assert.deepEqual(actionIds("envelope_completed", false, "completed"), [
    "certificate",
    "open",
  ]);
  assert.deepEqual(actionIds("envelope_stuck", true), ["remind", "open"]);
  assert.deepEqual(actionIds("envelope_expiring_soon", true), [
    "remind",
    "open",
  ]);
  assert.deepEqual(actionIds("envelope_stuck", false), ["open"]);
  assert.deepEqual(actionIds("envelope_signed", true), ["open"]);
  assert.equal(
    buildNotificationMessage({
      appUrl: "https://sign.example.com",
      envelope: { ...envelope, status: "completed" },
      kind: "envelope_completed",
      payload: {},
    }).actions[0]?.url,
    "https://sign.example.com/envelopes/env-1/certificate",
  );
});

test("without the site's address there are no buttons", () => {
  assert.deepEqual(
    buildNotificationMessage({
      appUrl: null,
      envelope,
      kind: "envelope_completed",
      payload: {},
    }).actions,
    [],
  );
});

test("progress edits one direct message, outcomes post a new one, and bursts wait", () => {
  assert.equal(placementFor("envelope_signed", "user", true), "in_place");
  assert.equal(placementFor("envelope_viewed", "user", true), "in_place");
  assert.equal(placementFor("envelope_completed", "user", true), "new_message");
  assert.equal(placementFor("envelope_declined", "user", true), "new_message");
  assert.equal(placementFor("envelope_stuck", "user", true), "new_message");
  assert.equal(
    placementFor("envelope_completed", "channel", true),
    "channel_thread",
  );
  assert.equal(
    placementFor("envelope_completed", "channel", false),
    "standalone",
  );
  assert.equal(placementFor("envelope_signed", "user", false), "standalone");
  assert.ok(BURST_KINDS.has("envelope_signed"));
  assert.ok(!BURST_KINDS.has("envelope_completed"));
  assert.ok(!IN_PLACE_KINDS.has("envelope_expiring_soon"));
});

test("a payload keeps who did it and nothing else", () => {
  assert.deepEqual(
    readNotificationPayload({
      declineReason: "Private reason",
      documentText: "secret",
      signerEmail: " riley@example.com ",
      signerName: "Riley",
      idleDays: 7,
      expiresAt: "not a number",
    }),
    { idleDays: 7, signerEmail: "riley@example.com", signerName: "Riley" },
  );
  assert.deepEqual(readNotificationPayload(null), {});
  assert.deepEqual(readNotificationPayload("text"), {});
});

test("retries wait longer each time, up to six hours", () => {
  const none = () => 0;

  assert.equal(retryDelaySeconds(1, none), 60);
  assert.equal(retryDelaySeconds(2, none), 120);
  assert.equal(retryDelaySeconds(3, none), 240);
  assert.equal(retryDelaySeconds(20, none), 6 * 60 * 60);
  // Up to a fifth more, so many failures do not all retry at once.
  assert.equal(
    retryDelaySeconds(1, () => 1),
    72,
  );
});

test("a failure becomes a later attempt, a pause, or the end", () => {
  const now = 1_000_000;
  const none = () => 0;

  assert.deepEqual(
    updateForFailure(
      { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
      1,
      now,
      none,
    ),
    {
      countAttempt: true,
      error: "internal_error",
      nextAttemptAt: now + 60,
      status: "pending",
    },
  );
  // Slack's own Retry-After wins when it is longer than the backoff.
  assert.deepEqual(
    updateForFailure(
      { error: "http_503", outcome: "retry", retryAfterSeconds: 600 },
      1,
      now,
      none,
    ),
    {
      countAttempt: true,
      error: "http_503",
      nextAttemptAt: now + 600,
      status: "pending",
    },
  );
  // A rate limit is a pause, not a failed attempt.
  assert.deepEqual(
    updateForFailure(
      { error: "ratelimited", outcome: "rate_limited", retryAfterSeconds: 30 },
      MAX_DELIVERY_ATTEMPTS,
      now,
      none,
    ),
    {
      countAttempt: false,
      error: "ratelimited",
      nextAttemptAt: now + 30,
      status: "pending",
    },
  );
  assert.deepEqual(
    updateForFailure(
      { error: "channel_not_found", outcome: "failed" },
      1,
      now,
      none,
    ),
    { error: "channel_not_found", status: "failed" },
  );
  assert.deepEqual(
    updateForFailure(
      { error: "invalid_auth", outcome: "auth" },
      MAX_DELIVERY_ATTEMPTS,
      now,
      none,
    ),
    { error: "invalid_auth", status: "failed" },
  );
  assert.equal(
    updateForFailure({ error: "invalid_auth", outcome: "auth" }, 2, now, none)
      .status,
    "pending",
  );
});

test("thresholds come from the environment, then settings, then defaults", () => {
  assert.deepEqual(
    readNotificationThresholds({}, EMPTY_NOTIFICATION_SETTINGS),
    {
      expiringDays: 3,
      expiringFromEnv: false,
      stuckDays: 7,
      stuckFromEnv: false,
    },
  );
  assert.deepEqual(
    readNotificationThresholds(
      { NOTIFICATION_STUCK_DAYS: "0" },
      { ...EMPTY_NOTIFICATION_SETTINGS, expiringDays: 5, stuckDays: 10 },
    ),
    {
      expiringDays: 5,
      expiringFromEnv: false,
      stuckDays: 0,
      stuckFromEnv: true,
    },
  );
  assert.equal(
    readNotificationThresholds(
      { NOTIFICATION_STUCK_DAYS: "999" },
      EMPTY_NOTIFICATION_SETTINGS,
    ).stuckDays,
    60,
  );
});

test("error codes are kept short and plain", () => {
  assert.equal(safeErrorCode("channel_not_found"), "channel_not_found");
  assert.equal(safeErrorCode("has spaces"), "unknown_error");
  assert.equal(safeErrorCode(42), "unknown_error");
  assert.equal(safeErrorCode("x".repeat(81)), "unknown_error");
});

test("an expired envelope's message says it expired and has no due date", () => {
  // An envelope that passed its deadline keeps the stored status 'sent'.
  const message = buildNotificationMessage({
    appUrl: "https://sign.example.com",
    envelope: { ...envelope, expiresAt: 1_800_000_000, status: "sent" },
    kind: "envelope_expired",
    occurredAt: 1_800_000_100,
    payload: {},
  });

  assert.ok(message.details.includes("Expired"), message.details.join(" | "));
  assert.ok(
    message.details.every((detail) => !detail.startsWith("Due ")),
    message.details.join(" | "),
  );
});

test("a warning the job made is only sent while it still holds", () => {
  const now = 1_800_000_000;
  const deadline = now + 2 * 24 * 60 * 60;
  const open = { expiresAt: deadline, status: "sent" };

  // A deadline coming up: for the deadline it was made for, while open.
  assert.equal(
    jobWarningStillHolds(
      "envelope_expiring_soon",
      open,
      { expiresAt: deadline },
      now,
    ),
    true,
  );
  assert.equal(
    jobWarningStillHolds(
      "envelope_expiring_soon",
      { ...open, expiresAt: deadline + 600 },
      { expiresAt: deadline },
      now,
    ),
    false,
    "the deadline was moved",
  );
  assert.equal(
    jobWarningStillHolds(
      "envelope_expiring_soon",
      { ...open, status: "completed" },
      { expiresAt: deadline },
      now,
    ),
    false,
    "everyone signed",
  );
  assert.equal(
    jobWarningStillHolds(
      "envelope_expiring_soon",
      open,
      { expiresAt: deadline },
      deadline + 1,
    ),
    false,
    "the deadline has passed",
  );

  // A deadline passed: only while that deadline is still the one set.
  assert.equal(
    jobWarningStillHolds(
      "envelope_expired",
      open,
      { expiresAt: deadline },
      deadline + 1,
    ),
    true,
  );
  assert.equal(
    jobWarningStillHolds(
      "envelope_expired",
      { ...open, expiresAt: deadline + 7 * 24 * 60 * 60 },
      { expiresAt: deadline },
      deadline + 1,
    ),
    false,
    "a new deadline was set",
  );

  // No activity: while it is open and its deadline has not passed.
  assert.equal(
    jobWarningStillHolds("envelope_stuck", open, { idleDays: 7 }, now),
    true,
  );
  assert.equal(
    jobWarningStillHolds(
      "envelope_stuck",
      { ...open, status: "voided" },
      { idleDays: 7 },
      now,
    ),
    false,
  );
  assert.equal(
    jobWarningStillHolds("envelope_stuck", open, { idleDays: 7 }, deadline + 1),
    false,
  );

  // Anything the audit trail recorded is not the job's to recheck.
  assert.equal(
    jobWarningStillHolds(
      "envelope_signed",
      { ...open, status: "completed" },
      {},
      now,
    ),
    true,
  );
});
