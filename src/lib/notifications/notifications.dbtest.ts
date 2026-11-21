import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";

import type pg from "pg";
import { z } from "zod";

import { withTransaction } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { recordAuditEvent } from "../services/audit.ts";
import type {
  LookupResult,
  NotificationChannel,
  SendResult,
} from "./channel.ts";
import { queueConditionEvents } from "./conditions.ts";
import { headlineText } from "./message.ts";
import {
  deliverDueDeliveries,
  discardQueuedEvents,
  expandQueuedEvents,
  MAX_DELIVERY_ATTEMPTS,
  nextDeliveryDueAt,
  type OutboxDeps,
  purgeOldNotifications,
} from "./outbox.ts";
import { runNotificationJob } from "./job.ts";
import {
  EMPTY_NOTIFICATION_SETTINGS,
  readNotificationSettings,
  updateNotificationSettings,
  type NotificationSettingsActor,
  type NotificationSettingsUpdate,
} from "./store.ts";

// The outbox against a real Postgres, with a fake chat tool: events are
// queued by the audit trigger in the audit event's own transaction, turned
// into one delivery per place exactly once, and sent with retries, pauses
// and backoff. Run with `npm run test:db`.

const DAY = 24 * 60 * 60;

let database: pg.Pool;
const createdUsers: string[] = [];
const createdRules: string[] = [];
const marker = `notify${randomUUID().slice(0, 8)}`;

type Account = { email: string; id: string };

let owner: Account;
let outsider: Account;
let admin: Account;

function fakeChannel() {
  const sent: { destination: string; headline: string }[] = [];
  const lookups: string[] = [];
  const results: SendResult[] = [];
  const users = new Map<string, string>();
  const channel: NotificationChannel = {
    destinationSchema: z.string(),
    id: "slack",
    async lookupUser(email): Promise<LookupResult> {
      lookups.push(email);

      const id = users.get(email);

      return id
        ? { externalId: id, outcome: "found" }
        : { outcome: "not_found" };
    },
    name: "Fake Slack",
    async send(destination, message, _context, options): Promise<SendResult> {
      sent.push({ destination, headline: headlineText(message.headline) });

      return (
        results.shift() ?? {
          outcome: "sent",
          thread:
            options && options.placement !== "standalone"
              ? (options.thread ?? {
                  conversation: destination,
                  ts: String(sent.length),
                })
              : null,
        }
      );
    },
    status: () => ({
      configured: true,
      directMessages: true,
      source: "settings",
    }),
  };

  return { channel, lookups, results, sent, users };
}

function depsFor(channel: NotificationChannel, now: number): OutboxDeps {
  return {
    appUrl: "https://sign.example.test",
    channels: [channel],
    context: { env: {}, stored: EMPTY_NOTIFICATION_SETTINGS },
    now: () => now,
    random: () => 0,
  };
}

async function createAccount(role: "admin" | "user"): Promise<Account> {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, $2, $3, true, $4)
    `,
    [id, `Person ${id.slice(0, 6)}`, email, role],
  );

  return { email, id };
}

async function createEnvelope(
  ownerId: string,
  {
    expiresAt = null,
    sentAt,
    status = "sent",
  }: { expiresAt?: number | null; sentAt: number; status?: string },
): Promise<string> {
  const id = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        expires_at, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, 'contract.pdf', 4, 1, $6, $7, $8, $7, $7)
    `,
    [
      id,
      ownerId,
      `Contract ${marker}`,
      status,
      `test/${id}.pdf`,
      "a".repeat(64),
      status === "draft" ? null : sentAt,
      expiresAt,
    ],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status
      ) values ($1, $2, 'Riley Recipient', $3, 1, 'notified')
    `,
    [randomUUID(), id, `riley-${id}@example.test`],
  );

  return id;
}

async function deliveriesFor(envelopeId: string) {
  const result = await database.query<{
    attempts: number;
    lastError: string | null;
    nextAttemptAt: number;
    status: string;
    target: string;
    targetKind: string;
  }>(
    `
      select d.target_kind as "targetKind", d.target, d.status, d.attempts,
        d.last_error as "lastError", d.next_attempt_at as "nextAttemptAt"
      from notification_deliveries d
      join notification_events e on e.id = d.event_id
      where e.envelope_id = $1
      order by d.target_kind, d.target
    `,
    [envelopeId],
  );

  return result.rows;
}

function places(rows: { target: string; targetKind: string }[]) {
  return rows.map((row) => `${row.targetKind}:${row.target}`).sort();
}

/** A person's own choice for one event, as Settings would save it. */
async function choose(userId: string, event: string, enabled: boolean) {
  await database.query(
    `
      insert into notification_preferences (
        user_id, channel, event, enabled, updated_at
      ) values ($1, 'slack', $2, $3, 0)
      on conflict (user_id, channel, event) do update set enabled = excluded.enabled
    `,
    [userId, event, enabled],
  );
}

/** Whatever an earlier test (or another file) left queued is not for the next one. */
async function clearOutbox() {
  await discardQueuedEvents(database, Math.floor(Date.now() / 1000));
  await database.query(
    `update notification_deliveries set status = 'skipped'
     where status in ('pending', 'sending')`,
  );
  await database.query(`delete from notification_channel_pauses`);
}

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;

  await clearOutbox();

  owner = await createAccount("user");
  outsider = await createAccount("user");
  admin = await createAccount("admin");

  // Two channels that take every envelope's completions and declines.
  for (const destination of ["C0EVERY1", "C0SECOND1"]) {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    createdRules.push(id);
    await database.query(
      `
        insert into notification_rules (
          id, channel, events, destination, enabled, created_at, updated_at
        ) values ($1, 'slack', $2, $3, true, $4, $4)
      `,
      [id, ["envelope_completed", "envelope_declined"], destination, now],
    );
  }
});

after(async () => {
  await database.query(`delete from notification_rules where id = any($1)`, [
    createdRules,
  ]);
  await database.query(`delete from notification_settings`);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

test("an audit event is queued in its own transaction, with who did it and nothing more", async () => {
  const now = Math.floor(Date.now() / 1000);
  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await assert.rejects(
    withTransaction(async (tx) => {
      await recordAuditEvent(
        {
          actorType: "signer",
          envelopeId,
          event: "declined",
          metadata: { reason: "Never shown", signerName: "Riley" },
        },
        tx,
      );
      throw new Error("rolled back");
    }, database),
    /rolled back/,
  );

  const none = await database.query(
    `select 1 from notification_events where envelope_id = $1`,
    [envelopeId],
  );

  assert.equal(none.rowCount, 0);

  await recordAuditEvent(
    {
      actorEmail: "riley@example.test",
      actorType: "signer",
      envelopeId,
      event: "declined",
      metadata: {
        reason: "Never shown",
        signerEmail: "riley@example.test",
        signerName: "Riley",
      },
    },
    database,
  );
  await recordAuditEvent(
    {
      actorType: "system",
      envelopeId,
      event: "email_sent",
      metadata: { recipient: "riley@example.test", template: "x" },
    },
    database,
  );

  const queued = await database.query<{
    event: string;
    payload: Record<string, unknown>;
    source: string;
  }>(
    `select source, event, payload from notification_events where envelope_id = $1`,
    [envelopeId],
  );

  assert.equal(queued.rowCount, 1, "the email note is never queued");
  assert.equal(queued.rows[0]?.source, "audit");
  assert.equal(queued.rows[0]?.event, "declined");
  assert.deepEqual(queued.rows[0]?.payload, {
    actorEmail: "riley@example.test",
    actorType: "signer",
    signerEmail: "riley@example.test",
    signerName: "Riley",
  });
});

test("an event becomes one delivery per place, once, and the sender's choices count", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();
  const deps = depsFor(fake.channel, now);

  await expandQueuedEvents(database, deps);

  // The outsider turns "Completed" off; the owner keeps the default.
  await choose(outsider.id, "envelope_completed", false);

  const ownerEnvelope = await createEnvelope(owner.id, { sentAt: now });
  const outsiderEnvelope = await createEnvelope(outsider.id, { sentAt: now });

  for (const envelopeId of [ownerEnvelope, outsiderEnvelope]) {
    await recordAuditEvent(
      { actorType: "system", envelopeId, event: "completed" },
      database,
    );
  }

  const expanded = await expandQueuedEvents(database, deps);

  assert.equal(expanded.events, 2);
  assert.deepEqual(places(await deliveriesFor(ownerEnvelope)), [
    "channel:C0EVERY1",
    "channel:C0SECOND1",
    `user:${owner.id}`,
  ]);
  assert.deepEqual(places(await deliveriesFor(outsiderEnvelope)), [
    "channel:C0EVERY1",
    "channel:C0SECOND1",
  ]);

  // Processed events are not taken again, and an event processed twice
  // (a run cut off before it was marked) makes no second delivery.
  assert.deepEqual(await expandQueuedEvents(database, deps), {
    deliveries: 0,
    events: 0,
  });
  await database.query(
    `update notification_events set processed_at = null where envelope_id = $1`,
    [ownerEnvelope],
  );
  assert.deepEqual(await expandQueuedEvents(database, deps), {
    deliveries: 0,
    events: 1,
  });
  assert.equal((await deliveriesFor(ownerEnvelope)).length, 3);

  // Delivered: people are looked up once by email and remembered.
  fake.users.set(owner.email, "UOWNER");

  const summary = await deliverDueDeliveries(database, deps);

  assert.equal(summary.sent, 5);
  assert.deepEqual(fake.sent.map((item) => item.destination).sort(), [
    "C0EVERY1",
    "C0EVERY1",
    "C0SECOND1",
    "C0SECOND1",
    "UOWNER",
  ]);
  assert.ok(fake.sent.every((item) => item.headline.includes(marker)));

  // The outsider turns it back on, but has no Slack account.
  await choose(outsider.id, "envelope_declined", true);
  await recordAuditEvent(
    {
      actorType: "system",
      envelopeId: outsiderEnvelope,
      event: "declined",
    },
    database,
  );
  await expandQueuedEvents(database, deps);
  await deliverDueDeliveries(database, deps);

  const outsiderRow = (await deliveriesFor(outsiderEnvelope)).find(
    (row) => row.targetKind === "user",
  );

  assert.equal(outsiderRow?.status, "skipped");
  assert.equal(outsiderRow?.lastError, "no_matching_account");

  const lookupsBefore = fake.lookups.length;

  await recordAuditEvent(
    { actorType: "system", envelopeId: ownerEnvelope, event: "declined" },
    database,
  );
  await expandQueuedEvents(database, deps);
  await deliverDueDeliveries(database, deps);
  assert.equal(
    fake.lookups.length,
    lookupsBefore,
    "the owner's Slack id was remembered",
  );
});

test("failed sends are retried with backoff, paused for rate limits, and given up on", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();
  const envelopeId = await createEnvelope(outsider.id, { sentAt: now });

  await expandQueuedEvents(database, depsFor(fake.channel, now));
  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "declined" },
    database,
  );
  await expandQueuedEvents(database, depsFor(fake.channel, now));

  const channelRows = async () =>
    (await deliveriesFor(envelopeId)).filter(
      (row) => row.target === "C0SECOND1",
    );

  // The outsider is not in Slack; only the channel posts matter here.
  fake.results.push(
    { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
    { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
  );
  await deliverDueDeliveries(database, depsFor(fake.channel, now));

  let [second] = await channelRows();

  assert.equal(second?.status, "pending");
  assert.equal(second?.attempts, 1);
  assert.equal(second?.lastError, "internal_error");
  assert.ok(second && second.nextAttemptAt >= now + 60);

  // Not due yet: nothing is tried.
  const sentBefore = fake.sent.length;

  await deliverDueDeliveries(database, depsFor(fake.channel, now + 30));
  assert.equal(fake.sent.length, sentBefore);

  // A rate limit puts it back without counting the attempt, and stops
  // everything else to that tool in the same run.
  fake.results.length = 0;
  fake.results.push({
    error: "ratelimited",
    outcome: "rate_limited",
    retryAfterSeconds: 120,
  });
  const sentBeforeLimit = fake.sent.length;

  await deliverDueDeliveries(database, depsFor(fake.channel, now + 400));
  [second] = await channelRows();
  assert.equal(second?.status, "pending");
  assert.equal(second?.attempts, 1);
  assert.ok(second && second.nextAttemptAt >= now + 400 + 120);

  // Whichever channel delivery was claimed first took the rate limit; the
  // other must have been held back too, not sent. Both share a due time, so
  // the claim order is arbitrary and both have to be checked.
  const bothChannelRows = (await deliveriesFor(envelopeId)).filter((row) =>
    ["C0EVERY1", "C0SECOND1"].includes(row.target),
  );

  assert.equal(bothChannelRows.length, 2);

  for (const row of bothChannelRows) {
    assert.equal(row.status, "pending", row.target);
    assert.equal(row.attempts, 1, row.target);
    assert.ok(row.nextAttemptAt >= now + 400 + 120, row.target);
  }

  assert.equal(
    fake.sent.length - sentBeforeLimit,
    1,
    "only the delivery that hit the limit was tried",
  );

  // After the last attempt, it fails for good.
  await database.query(
    `
      update notification_deliveries set attempts = $2
      where target = 'C0SECOND1' and event_id in (
        select id from notification_events where envelope_id = $1
      )
    `,
    [envelopeId, MAX_DELIVERY_ATTEMPTS - 1],
  );
  fake.results.length = 0;
  fake.results.push(
    { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
    { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
  );
  await deliverDueDeliveries(database, depsFor(fake.channel, now + 10 * DAY));
  [second] = await channelRows();
  assert.equal(second?.status, "failed");
  assert.equal(second?.attempts, MAX_DELIVERY_ATTEMPTS);
  await database.query(`delete from notification_channel_pauses`);
});

test("a delivery whose lease ran out is taken again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();
  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(fake.channel, now));
  await database.query(
    `
      update notification_deliveries set status = 'sending', locked_until = $2
      where event_id in (select id from notification_events where envelope_id = $1)
    `,
    [envelopeId, now + 60],
  );

  await deliverDueDeliveries(database, depsFor(fake.channel, now));
  assert.equal(fake.sent.length, 0, "still leased to another run");

  await deliverDueDeliveries(database, depsFor(fake.channel, now + 61));
  assert.ok(fake.sent.length > 0);
});

test("deadlines coming up and idle envelopes are queued once each", async () => {
  const now = Math.floor(Date.now() / 1000);
  const idle = await createEnvelope(owner.id, { sentAt: now - 10 * DAY });
  const busy = await createEnvelope(owner.id, { sentAt: now - 10 * DAY });
  const expiring = await createEnvelope(owner.id, {
    expiresAt: now + 2 * DAY,
    sentAt: now - 5 * DAY,
  });

  await recordAuditEvent(
    {
      actorType: "signer",
      createdAt: now - DAY,
      envelopeId: busy,
      event: "viewed",
    },
    database,
  );

  const first = await queueConditionEvents(database, {
    expiringDays: 3,
    now,
    stuckDays: 7,
  });

  assert.ok(first.stuck >= 1);
  assert.ok(first.expiringSoon >= 1);

  const kinds = await database.query<{ dedupeKey: string }>(
    `
      select dedupe_key as "dedupeKey" from notification_events
      where source = 'job' and envelope_id = any($1)
      order by dedupe_key
    `,
    [[idle, busy, expiring]],
  );

  assert.deepEqual(
    kinds.rows.map((row) => row.dedupeKey).sort(),
    [
      `envelope_expiring_soon:${expiring}:${String(now + 2 * DAY)}`,
      `envelope_stuck:${idle}`,
    ].sort(),
  );

  const second = await queueConditionEvents(database, {
    expiringDays: 3,
    now: now + 60,
    stuckDays: 7,
  });

  assert.deepEqual(second, { expired: 0, expiringSoon: 0, stuck: 0 });
});

test("a missing scope on the address lookup does not stop posts to channels", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const channel: NotificationChannel = {
    ...fake.channel,
    async lookupUser(email): Promise<LookupResult> {
      fake.lookups.push(email);

      return { error: "missing_scope", outcome: "auth" };
    },
  };

  await clearOutbox();
  await database.query(
    `delete from notification_identities where user_id = any($1)`,
    [[owner.id, outsider.id]],
  );

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  // The direct messages come first in the run.
  await database.query(
    `
      update notification_deliveries set next_attempt_at = $2
      where target_kind = 'user' and event_id in (
        select id from notification_events where envelope_id = $1
      )
    `,
    [envelopeId, now - 10],
  );
  await deliverDueDeliveries(database, depsFor(channel, now));

  const rows = await deliveriesFor(envelopeId);
  const channelRows = rows.filter((row) => row.targetKind === "channel");

  assert.ok(channelRows.length > 0);
  assert.ok(fake.lookups.length > 0, "the lookup was tried");

  for (const row of channelRows) {
    assert.equal(row.status, "sent", `${row.target}: ${String(row.lastError)}`);
    assert.equal(row.attempts, 1);
  }
});

test("a remembered address that Slack no longer knows is looked up again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const channel: NotificationChannel = {
    ...fake.channel,
    async send(destination, message, context, options): Promise<SendResult> {
      if (destination === "USTALE") {
        fake.sent.push({ destination, headline: "stale" });

        return { error: "channel_not_found", outcome: "failed" };
      }

      return fake.channel.send(destination, message, context, options);
    },
  };

  await clearOutbox();
  fake.users.set(owner.email.toLowerCase(), "UFRESH");
  await database.query(
    `
      insert into notification_identities (
        user_id, channel, lookup_email, external_id, checked_at
      ) values ($1, 'slack', $2, 'USTALE', $3)
      on conflict (user_id, channel) do update set
        lookup_email = excluded.lookup_email,
        external_id = excluded.external_id,
        checked_at = excluded.checked_at
    `,
    [owner.id, owner.email.toLowerCase(), now],
  );

  const first = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId: first, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  await deliverDueDeliveries(database, depsFor(channel, now));

  const firstDm = (await deliveriesFor(first)).find(
    (row) => row.targetKind === "user" && row.target === owner.id,
  );

  assert.equal(firstDm?.status, "failed");

  const second = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId: second, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  await deliverDueDeliveries(database, depsFor(channel, now));

  const secondDm = (await deliveriesFor(second)).find(
    (row) => row.targetKind === "user" && row.target === owner.id,
  );

  assert.equal(secondDm?.status, "sent");
  assert.ok(
    fake.sent.some((item) => item.destination === "UFRESH"),
    "the second message went to the new Slack id",
  );
});

test("a send that throws is logged and retried", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const channel: NotificationChannel = {
    ...fake.channel,
    async send(): Promise<SendResult> {
      throw new TypeError("boom");
    },
  };
  const warn = mock.method(console, "warn", () => {});

  try {
    await clearOutbox();

    const envelopeId = await createEnvelope(outsider.id, { sentAt: now });

    await recordAuditEvent(
      { actorType: "system", envelopeId, event: "declined" },
      database,
    );
    await expandQueuedEvents(database, depsFor(channel, now));
    await deliverDueDeliveries(database, depsFor(channel, now));

    const second = (await deliveriesFor(envelopeId)).find(
      (row) => row.target === "C0SECOND1",
    );

    assert.equal(second?.status, "pending");
    assert.equal(second?.lastError, "send_threw");
    assert.ok(
      warn.mock.calls.some((call) =>
        call.arguments.some((argument) => String(argument).includes("boom")),
      ),
      "the cause was logged",
    );
  } finally {
    warn.mock.restore();
  }
});

test("a delivery that throws before sending does not stop the rest of the batch", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const channel: NotificationChannel = {
    ...fake.channel,
    async lookupUser(): Promise<LookupResult> {
      throw new RangeError("lookup exploded");
    },
  };
  const warn = mock.method(console, "warn", () => {});

  try {
    await clearOutbox();
    await database.query(
      `delete from notification_identities where user_id = any($1)`,
      [[owner.id, outsider.id]],
    );

    const envelopeId = await createEnvelope(owner.id, { sentAt: now });

    await recordAuditEvent(
      { actorType: "system", envelopeId, event: "completed" },
      database,
    );
    await expandQueuedEvents(database, depsFor(channel, now));
    await database.query(
      `
        update notification_deliveries set next_attempt_at = $2
        where target_kind = 'user' and event_id in (
          select id from notification_events where envelope_id = $1
        )
      `,
      [envelopeId, now - 10],
    );
    await deliverDueDeliveries(database, depsFor(channel, now));

    const rows = await deliveriesFor(envelopeId);

    for (const row of rows.filter((item) => item.targetKind === "channel")) {
      assert.equal(row.status, "sent", row.target);
    }

    const dm = rows.find((row) => row.target === owner.id);

    assert.equal(dm?.status, "pending");
    assert.equal(dm?.attempts, 1, "the try is counted");
  } finally {
    warn.mock.restore();
  }
});

test("a delivery left 'sending' after its last attempt is failed, not taken again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(fake.channel, now));
  await database.query(
    `
      update notification_deliveries
      set status = 'sending', locked_until = $2, attempts = $3
      where event_id in (select id from notification_events where envelope_id = $1)
    `,
    [envelopeId, now - 1, MAX_DELIVERY_ATTEMPTS],
  );
  await deliverDueDeliveries(database, depsFor(fake.channel, now));

  const rows = await deliveriesFor(envelopeId);

  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((row) => row.status === "failed"),
    rows.map((row) => row.status).join(","),
  );
  assert.equal(fake.sent.length, 0);
});

const TOKEN_A = "xoxb-1111111111-tokenAAAAAA";
const TOKEN_B = "xoxb-2222222222-tokenBBBBBB";
const settingsEnv = { ...process.env, BETTER_AUTH_SECRET: "a".repeat(40) };

async function seedSlackMemory() {
  const envelopeId = await createEnvelope(owner.id, {
    sentAt: Math.floor(Date.now() / 1000),
  });

  await database.query(
    `
      insert into notification_identities (
        user_id, channel, lookup_email, external_id, checked_at
      ) values ($1, 'slack', $2, 'UOLD', 1)
      on conflict (user_id, channel) do update set external_id = 'UOLD'
    `,
    [owner.id, owner.email.toLowerCase()],
  );
  await database.query(
    `
      insert into notification_threads (
        envelope_id, channel, target_kind, target, conversation, message_ts,
        created_at, updated_at
      ) values ($1, 'slack', 'user', $2, 'DOLD', '1.1', 1, 1)
    `,
    [envelopeId, owner.id],
  );

  return envelopeId;
}

async function slackMemoryCounts(envelopeId: string) {
  const identities = await database.query(
    `select 1 from notification_identities where user_id = $1 and channel = 'slack'`,
    [owner.id],
  );
  const threads = await database.query(
    `select 1 from notification_threads where envelope_id = $1`,
    [envelopeId],
  );

  return { identities: identities.rows.length, threads: threads.rows.length };
}

/** Changes the stored settings, recorded as `actor`, in one transaction. */
function saveSettings(
  actor: NotificationSettingsActor,
  update: NotificationSettingsUpdate,
  pool: pg.Pool = database,
) {
  return withTransaction(
    (tx) => updateNotificationSettings(tx, update, actor, settingsEnv),
    pool,
  );
}

async function resetSlackSettings() {
  await database.query(`delete from notification_settings`);
}

test("a new Slack token is stored encrypted, recorded without its value, and wipes the old workspace's memory", async () => {
  const actor = { email: admin.email, id: admin.id };

  await resetSlackSettings();
  await saveSettings(actor, { slackBotToken: TOKEN_A });

  const envelopeId = await seedSlackMemory();

  await saveSettings(actor, { slackBotToken: TOKEN_B });

  assert.deepEqual(await slackMemoryCounts(envelopeId), {
    identities: 0,
    threads: 0,
  });

  const raw = await database.query<{ value: string | null }>(
    `select slack_bot_token_encrypted as value from notification_settings`,
  );

  assert.ok(raw.rows[0]?.value);
  assert.ok(!raw.rows[0].value.includes(TOKEN_B), "never stored in the clear");
  assert.equal(
    (await readNotificationSettings(database, settingsEnv)).slackBotToken,
    TOKEN_B,
  );

  // Read with another secret, the token cannot be opened: not set up.
  assert.equal(
    (
      await readNotificationSettings(database, {
        ...settingsEnv,
        BETTER_AUTH_SECRET: "b".repeat(40),
      })
    ).slackBotToken,
    null,
  );

  const audit = await database.query<{ metadata: Record<string, unknown> }>(
    `
      select metadata from system_audit_events
      where event = 'settings_changed' and actor_user_id = $1
        and metadata->>'area' = 'notifications'
      order by sequence desc limit 1
    `,
    [admin.id],
  );

  assert.deepEqual(audit.rows[0]?.metadata, {
    area: "notifications",
    changes: { slackBotToken: "saved" },
  });
  assert.ok(!JSON.stringify(audit.rows).includes("xoxb-"));
});

test("saving the same Slack token again keeps the remembered people and threads", async () => {
  const actor = { email: admin.email, id: admin.id };

  await resetSlackSettings();
  await saveSettings(actor, { slackBotToken: TOKEN_A });

  const envelopeId = await seedSlackMemory();

  await saveSettings(actor, { slackBotToken: TOKEN_A });

  assert.deepEqual(await slackMemoryCounts(envelopeId), {
    identities: 1,
    threads: 1,
  });
});

test("removing the Slack token wipes the remembered people and threads", async () => {
  const actor = { email: admin.email, id: admin.id };

  await resetSlackSettings();
  await saveSettings(actor, { slackBotToken: TOKEN_A });

  const envelopeId = await seedSlackMemory();

  await saveSettings(actor, { slackBotToken: null });

  assert.deepEqual(await slackMemoryCounts(envelopeId), {
    identities: 0,
    threads: 0,
  });
  assert.equal(
    (await readNotificationSettings(database, settingsEnv)).slackBotToken,
    null,
  );
});

test("a failed wipe leaves the old Slack token in place", async () => {
  const actor = { email: admin.email, id: admin.id };

  await resetSlackSettings();
  await saveSettings(actor, { slackBotToken: TOKEN_A });

  const envelopeId = await seedSlackMemory();
  const guard = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, property) {
        if (property === "query") {
          return (text: unknown, ...rest: unknown[]) =>
            typeof text === "string" &&
            /DELETE FROM notification_identities/i.test(text)
              ? Promise.reject(new Error("the delete failed"))
              : (
                  inner as unknown as {
                    query: (...args: unknown[]) => unknown;
                  }
                ).query(text, ...rest);
        }

        if (property === "connect") {
          return async () =>
            guard(
              await (
                inner as unknown as { connect: () => Promise<object> }
              ).connect(),
            );
        }

        const value = Reflect.get(inner, property, inner) as unknown;

        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(inner)
          : value;
      },
    });

  await assert.rejects(
    saveSettings(actor, { slackBotToken: TOKEN_B }, guard(database)),
    /the delete failed/,
  );

  assert.equal(
    (await readNotificationSettings(database, settingsEnv)).slackBotToken,
    TOKEN_A,
  );
  assert.deepEqual(await slackMemoryCounts(envelopeId), {
    identities: 1,
    threads: 1,
  });
});

/** Sends the owner one direct message about a fresh envelope. */
async function directMessageToOwner(
  channel: NotificationChannel,
  now: number,
): Promise<string> {
  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  await database.query(
    `
      update notification_deliveries set next_attempt_at = $2
      where target_kind = 'user' and event_id in (
        select id from notification_events where envelope_id = $1
      )
    `,
    [envelopeId, now - 10],
  );
  await deliverDueDeliveries(database, depsFor(channel, now));

  return envelopeId;
}

async function rememberIdentity(
  lookupEmail: string,
  externalId: string | null,
  checkedAt: number,
) {
  await database.query(
    `delete from notification_identities where user_id = any($1)`,
    [[owner.id, outsider.id, admin.id]],
  );
  await database.query(
    `
      insert into notification_identities (
        user_id, channel, lookup_email, external_id, checked_at
      ) values ($1, 'slack', $2, $3, $4)
    `,
    [owner.id, lookupEmail, externalId, checkedAt],
  );
}

test("a remembered address is only trusted for the email it was found by", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();
  fake.users.set(owner.email.toLowerCase(), "UNEW");
  await rememberIdentity("old-address@example.test", "UOLD", now);
  await directMessageToOwner(fake.channel, now);

  assert.ok(
    fake.lookups.includes(owner.email.toLowerCase()),
    "the new address was looked up",
  );
  assert.ok(fake.sent.some((item) => item.destination === "UNEW"));
  assert.ok(
    !fake.sent.some((item) => item.destination === "UOLD"),
    "nothing went to the member found by the old address",
  );
});

test("'nobody has this address' is believed for a day, then asked again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const email = owner.email.toLowerCase();

  await clearOutbox();

  const recent = fakeChannel();

  recent.users.set(email, "UFOUND");
  await rememberIdentity(email, null, now - DAY + 100);

  const recentEnvelope = await directMessageToOwner(recent.channel, now);

  assert.ok(!recent.lookups.includes(email), "no lookup inside the day");
  assert.ok(!recent.sent.some((item) => item.destination === "UFOUND"));
  assert.equal(
    (await deliveriesFor(recentEnvelope)).find((row) => row.target === owner.id)
      ?.lastError,
    "no_matching_account",
  );

  await clearOutbox();

  const old = fakeChannel();

  old.users.set(email, "UFOUND");
  await rememberIdentity(email, null, now - DAY - 100);
  await directMessageToOwner(old.channel, now);

  assert.ok(old.lookups.includes(email), "looked up again after the day");
  assert.ok(old.sent.some((item) => item.destination === "UFOUND"));
});

test("deliveries claimed after time ran out go back untried, with no attempt counted", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(fake.channel, now));
  await database.query(
    `
      update notification_deliveries
      set next_attempt_at = $2, attempts = 2
      where event_id in (select id from notification_events where envelope_id = $1)
    `,
    [envelopeId, now - 10],
  );

  // Time is left when the batch is claimed and gone when each is tried.
  let checks = 0;

  await deliverDueDeliveries(database, depsFor(fake.channel, now), {
    outOfTime: () => (checks += 1) > 1,
  });

  const rows = await database.query<{
    attempts: number;
    lockedUntil: number | null;
    nextAttemptAt: number;
    status: string;
  }>(
    `
      select d.status, d.attempts, d.locked_until as "lockedUntil",
        d.next_attempt_at as "nextAttemptAt"
      from notification_deliveries d
      join notification_events e on e.id = d.event_id
      where e.envelope_id = $1
    `,
    [envelopeId],
  );

  assert.ok(rows.rows.length > 0);

  for (const row of rows.rows) {
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 2, "no attempt was counted");
    assert.equal(row.lockedUntil, null, "the lease was given back");
    assert.equal(row.nextAttemptAt, now, "due again right away");
  }

  assert.equal(fake.sent.length, 0);
  assert.equal(fake.lookups.length, 0);
});

test("the next waiting delivery is the earliest one still ahead, within the window", async () => {
  const now = Math.floor(Date.now() / 1000);
  const eventId = randomUUID();

  await clearOutbox();
  await database.query(
    `
      insert into notification_events (
        id, dedupe_key, source, event, envelope_id, created_at, processed_at
      ) values ($1, $1, 'job', 'probe', null, $2, $2)
    `,
    [eventId, now],
  );

  try {
    const waiting: [string, number][] = [
      ["pending", now + 100],
      ["pending", now + 50],
      ["pending", now - 5],
      ["pending", now + 9999],
      ["sent", now + 10],
    ];

    for (const [index, [status, next]] of waiting.entries()) {
      await database.query(
        `
          insert into notification_deliveries (
            id, event_id, channel, target_kind, target, status,
            next_attempt_at, created_at, updated_at
          ) values ($1, $2, 'slack', 'channel', $3, $4, $5, $6, $6)
        `,
        [randomUUID(), eventId, `C0PROBE${index}`, status, next, now],
      );
    }

    assert.equal(await nextDeliveryDueAt(database, now, 1000), now + 50);
    assert.equal(await nextDeliveryDueAt(database, now, 20), null);
  } finally {
    await database.query(`delete from notification_events where id = $1`, [
      eventId,
    ]);
  }
});

test("purging keeps what is still needed and deletes the rest", async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = now - 31 * DAY;
  const sentEnvelope = await createEnvelope(owner.id, { sentAt: now });
  const doneEnvelope = await createEnvelope(owner.id, {
    sentAt: now,
    status: "completed",
  });
  const events = {
    deletable: randomUUID(),
    doneMarker: randomUUID(),
    liveMarker: randomUUID(),
    pending: randomUUID(),
    recent: randomUUID(),
    sending: randomUUID(),
  };
  const insertEvent = (
    id: string,
    source: string,
    envelopeId: string | null,
    processedAt: number,
  ) =>
    database.query(
      `
        insert into notification_events (
          id, dedupe_key, source, event, envelope_id, created_at, processed_at
        ) values ($1, $1, $2, 'probe', $3, $4, $4)
      `,
      [id, source, envelopeId, processedAt],
    );
  const insertDelivery = (eventId: string, status: string) =>
    database.query(
      `
        insert into notification_deliveries (
          id, event_id, channel, target_kind, target, status,
          next_attempt_at, created_at, updated_at
        ) values ($1, $2, 'slack', 'channel', 'C0PURGE', $3, $4, $4, $4)
      `,
      [randomUUID(), eventId, status, now],
    );

  await insertEvent(events.deletable, "audit", sentEnvelope, old);
  await insertEvent(events.pending, "audit", sentEnvelope, old);
  await insertDelivery(events.pending, "pending");
  await insertEvent(events.sending, "audit", sentEnvelope, old);
  await insertDelivery(events.sending, "sending");
  await insertEvent(events.liveMarker, "job", sentEnvelope, old);
  await insertEvent(events.doneMarker, "job", doneEnvelope, old);
  await insertEvent(events.recent, "audit", sentEnvelope, now - 5 * DAY);

  const idle = {
    envelopeId: await createEnvelope(owner.id, { sentAt: now }),
    target: "T0IDLE",
  };
  const leased = {
    envelopeId: await createEnvelope(owner.id, { sentAt: now }),
    target: "T0LEASED",
  };
  const fresh = {
    envelopeId: await createEnvelope(owner.id, { sentAt: now }),
    target: "T0FRESH",
  };
  const insertThread = (
    item: { envelopeId: string; target: string },
    updatedAt: number,
    leaseUntil: number | null,
  ) =>
    database.query(
      `
        insert into notification_threads (
          envelope_id, channel, target_kind, target, lease_until,
          created_at, updated_at
        ) values ($1, 'slack', 'channel', $2, $3, $4, $4)
      `,
      [item.envelopeId, item.target, leaseUntil, updatedAt],
    );

  await insertThread(idle, now - 91 * DAY, null);
  await insertThread(leased, now - 91 * DAY, now + 100);
  await insertThread(fresh, now - DAY, null);

  await purgeOldNotifications(database, now);

  const remaining = await database.query<{ id: string }>(
    `select id from notification_events where id = any($1)`,
    [Object.values(events)],
  );
  const kept = new Set(remaining.rows.map((row) => row.id));

  assert.ok(!kept.has(events.deletable), "an old, finished event is deleted");
  assert.ok(
    !kept.has(events.doneMarker),
    "a job marker for a finished envelope is deleted",
  );
  assert.ok(kept.has(events.pending), "a pending delivery keeps its event");
  assert.ok(kept.has(events.sending), "a sending delivery keeps its event");
  assert.ok(
    kept.has(events.liveMarker),
    "a job marker stays while its envelope is out for signature",
  );
  assert.ok(kept.has(events.recent), "a recently processed event stays");

  const threads = await database.query<{ target: string }>(
    `select target from notification_threads where envelope_id = any($1)`,
    [[idle.envelopeId, leased.envelopeId, fresh.envelopeId]],
  );

  assert.deepEqual(threads.rows.map((row) => row.target).sort(), [
    "T0FRESH",
    "T0LEASED",
  ]);
});

/** A chat tool that counts as set up only when the token is in the environment. */
function envOnlyChannel() {
  const fake = fakeChannel();

  fake.channel.status = (context) => ({
    configured: Boolean(context.env.SLACK_BOT_TOKEN),
    directMessages: true,
    source: "env",
  });

  return fake;
}

async function queuedEventCount(envelopeId: string, processed: boolean) {
  const result = await database.query(
    `
      select 1 from notification_events
      where envelope_id = $1 and source = 'audit'
        and (processed_at is not null) = $2
    `,
    [envelopeId, processed],
  );

  return result.rows.length;
}

test("a notification run with a chat tool set up in the environment expands and sends", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = envOnlyChannel();

  await clearOutbox();

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );

  const summary = await runNotificationJob({
    channels: [fake.channel],
    database,
    deadline: Date.now() + 10_000,
    detectConditions: false,
    env: { ...settingsEnv, SLACK_BOT_TOKEN: TOKEN_A },
    now: () => now,
  });

  assert.equal(summary.status, "ran");
  assert.ok(summary.status === "ran" && summary.eventsProcessed >= 1);
  assert.ok(summary.status === "ran" && summary.deliveriesCreated >= 1);
  assert.ok((await deliveriesFor(envelopeId)).length >= 1);
  assert.ok(fake.sent.length >= 1, "the queued event was delivered");
});

test("a notification run with no chat tool set up discards what was queued", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = envOnlyChannel();
  const env: Record<string, string | undefined> = { ...settingsEnv };

  delete env.SLACK_BOT_TOKEN;
  await clearOutbox();

  const first = await createEnvelope(owner.id, { sentAt: now });
  const second = await createEnvelope(owner.id, { sentAt: now });

  for (const envelopeId of [first, second]) {
    await recordAuditEvent(
      { actorType: "system", envelopeId, event: "completed" },
      database,
    );
  }

  const summary = await runNotificationJob({
    channels: [fake.channel],
    database,
    deadline: Date.now() + 10_000,
    env,
    now: () => now,
  });

  assert.ok(summary.status === "not_configured" && summary.discarded === 2);
  assert.equal(await queuedEventCount(first, false), 0);
  assert.equal(await queuedEventCount(second, false), 0);
  assert.equal((await deliveriesFor(first)).length, 0);
  assert.equal(fake.sent.length, 0);
});

test("only a scheduled notification run clears out old events", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = envOnlyChannel();
  const env = { ...settingsEnv, SLACK_BOT_TOKEN: TOKEN_A };

  await clearOutbox();

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await runNotificationJob({
    channels: [fake.channel],
    database,
    deadline: Date.now() + 10_000,
    detectConditions: false,
    env,
    now: () => now,
  });
  assert.equal(await queuedEventCount(envelopeId, true), 1);

  // A month and a day later, a run that notices nothing new leaves it.
  const later = now + 31 * DAY;
  const kicked = await runNotificationJob({
    channels: [fake.channel],
    database,
    deadline: Date.now() + 10_000,
    detectConditions: false,
    env,
    now: () => later,
  });

  assert.ok(kicked.status === "ran" && kicked.purged === 0);
  assert.equal(await queuedEventCount(envelopeId, true), 1);

  const scheduled = await runNotificationJob({
    channels: [fake.channel],
    database,
    deadline: Date.now() + 10_000,
    env,
    now: () => later,
  });

  assert.ok(scheduled.status === "ran" && scheduled.purged >= 1);
  assert.equal(await queuedEventCount(envelopeId, true), 0);
});

test("a Slack token changed in the environment forgets the old workspace's people and threads", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = envOnlyChannel();

  fake.channel.accountKey = (context) => context.env.SLACK_BOT_TOKEN ?? null;
  await clearOutbox();

  const runWith = (token: string) =>
    runNotificationJob({
      channels: [fake.channel],
      database,
      deadline: Date.now() + 10_000,
      detectConditions: false,
      env: { ...settingsEnv, SLACK_BOT_TOKEN: token },
      now: () => now,
    });

  await runWith(TOKEN_A);

  const envelopeId = await seedSlackMemory();

  await runWith(TOKEN_A);
  assert.deepEqual(await slackMemoryCounts(envelopeId), {
    identities: 1,
    threads: 1,
  });

  await runWith(TOKEN_B);
  assert.deepEqual(await slackMemoryCounts(envelopeId), {
    identities: 0,
    threads: 0,
  });
});

test("after a sender's email address changes, their messages go to the person it now finds", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const threads: (string | null)[] = [];
  const channel: NotificationChannel = {
    ...fake.channel,
    async send(destination, message, context, options): Promise<SendResult> {
      threads.push(options?.thread?.conversation ?? null);

      return fake.channel.send(destination, message, context, options);
    },
  };
  const sender = await createAccount("user");
  const newEmail = `moved-${sender.email}`;

  await clearOutbox();
  await choose(sender.id, "envelope_sent", true);
  await choose(sender.id, "envelope_voided", true);
  fake.users.set(sender.email, "UFIRST");
  fake.users.set(newEmail, "USECOND");

  const envelopeId = await createEnvelope(sender.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "sent" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  await deliverDueDeliveries(database, depsFor(channel, now));

  await database.query(`update public."user" set email = $2 where id = $1`, [
    sender.id,
    newEmail,
  ]);
  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "voided" },
    database,
  );
  await expandQueuedEvents(database, depsFor(channel, now));
  await deliverDueDeliveries(database, depsFor(channel, now));

  assert.deepEqual(
    fake.sent.map((item) => item.destination),
    ["UFIRST", "USECOND"],
  );
  // The message in the old account's direct messages is left alone.
  assert.deepEqual(threads, [null, null]);
});

test("a rule paused, or an event turned off, after a message was queued stops it", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const deps = depsFor(fake.channel, now);

  await clearOutbox();
  fake.users.set(owner.email, "UOWNER");

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, deps);

  try {
    await database.query(
      `update notification_rules set enabled = false where destination = 'C0SECOND1'`,
    );
    await choose(owner.id, "envelope_completed", false);
    await deliverDueDeliveries(database, deps);
  } finally {
    await database.query(
      `update notification_rules set enabled = true where destination = 'C0SECOND1'`,
    );
    await database.query(
      `delete from notification_preferences where user_id = $1 and event = 'envelope_completed'`,
      [owner.id],
    );
  }

  assert.deepEqual(
    (await deliveriesFor(envelopeId)).map(
      (row) => `${row.targetKind}:${row.target}:${row.status}`,
    ),
    [
      "channel:C0EVERY1:sent",
      "channel:C0SECOND1:skipped",
      `user:${owner.id}:skipped`,
    ],
  );
  assert.deepEqual(
    fake.sent.map((item) => item.destination),
    ["C0EVERY1"],
  );
});

test("several openings within a minute make one message", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();
  const sender = await createAccount("user");

  await clearOutbox();
  await choose(sender.id, "envelope_viewed", true);
  fake.users.set(sender.email, "USENDER");

  const envelopeId = await createEnvelope(sender.id, { sentAt: now - 60 });

  for (const createdAt of [now - 20, now - 10]) {
    await recordAuditEvent(
      { actorType: "signer", createdAt, envelopeId, event: "viewed" },
      database,
    );
  }

  await expandQueuedEvents(database, depsFor(fake.channel, now));
  await deliverDueDeliveries(database, depsFor(fake.channel, now + 120));

  assert.deepEqual(
    (await deliveriesFor(envelopeId)).map((row) => row.status).sort(),
    ["sent", "skipped"],
  );
  assert.equal(fake.sent.length, 1);
});

test("an envelope past its deadline is announced as expired once per deadline, without email, and never as idle", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = await createEnvelope(owner.id, {
    expiresAt: now - DAY,
    sentAt: now - 10 * DAY,
  });
  const conditions = { expiringDays: 3, now, stuckDays: 7 };

  await queueConditionEvents(database, conditions);
  await queueConditionEvents(database, { ...conditions, now: now + 60 });

  const queued = await database.query<{ dedupeKey: string }>(
    `
      select dedupe_key as "dedupeKey" from notification_events
      where source = 'job' and envelope_id = $1
    `,
    [expired],
  );

  assert.deepEqual(
    queued.rows.map((row) => row.dedupeKey),
    [`envelope_expired:${expired}:${String(now - DAY)}`],
  );

  // A new deadline that passes too is announced again.
  await database.query(`update envelopes set expires_at = $2 where id = $1`, [
    expired,
    now + 30,
  ]);
  await queueConditionEvents(database, { ...conditions, now: now + 60 });

  const again = await database.query(
    `
      select 1 from notification_events
      where source = 'job' and envelope_id = $1
        and event = 'envelope_expired'
    `,
    [expired],
  );

  assert.equal(again.rows.length, 2);
});

test("a scheduled run with no chat tool set up still clears out old events", async () => {
  const now = Math.floor(Date.now() / 1000);
  const env: Record<string, string | undefined> = { ...settingsEnv };

  delete env.SLACK_BOT_TOKEN;
  await clearOutbox();

  const envelopeId = await createEnvelope(owner.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId, event: "completed" },
    database,
  );
  await discardQueuedEvents(database, now - 31 * DAY);

  const summary = await runNotificationJob({
    channels: [envOnlyChannel().channel],
    database,
    deadline: Date.now() + 10_000,
    env,
    now: () => now,
  });

  assert.equal(summary.status, "not_configured");
  assert.equal(await queuedEventCount(envelopeId, true), 0);
});

test("a pause Slack asked one run for holds back every run until it ends", async () => {
  const now = Math.floor(Date.now() / 1000);
  const first = fakeChannel();
  const second = fakeChannel();

  await clearOutbox();

  const earlier = await createEnvelope(outsider.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId: earlier, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(first.channel, now));
  first.results.push({
    error: "ratelimited",
    outcome: "rate_limited",
    retryAfterSeconds: 120,
  });
  await deliverDueDeliveries(database, depsFor(first.channel, now));
  assert.equal(first.sent.length, 1);

  // Another run, as in another server instance, with nothing in memory.
  const during = await createEnvelope(outsider.id, { sentAt: now });

  await recordAuditEvent(
    { actorType: "system", envelopeId: during, event: "completed" },
    database,
  );
  await expandQueuedEvents(database, depsFor(second.channel, now + 10));
  await deliverDueDeliveries(database, depsFor(second.channel, now + 10));
  assert.equal(second.sent.length, 0, "nothing goes to Slack during the pause");

  for (const row of await deliveriesFor(during)) {
    assert.equal(row.status, "pending", row.target);
    assert.equal(row.attempts, 0, row.target);
    assert.equal(row.nextAttemptAt, now + 120, row.target);
  }

  // Once it ends, everything held back goes out.
  await deliverDueDeliveries(database, depsFor(second.channel, now + 121));

  for (const envelopeId of [earlier, during]) {
    for (const row of await deliveriesFor(envelopeId)) {
      if (row.targetKind === "channel") {
        assert.equal(row.status, "sent", `${envelopeId} ${row.target}`);
      }
    }
  }

  await database.query(`delete from notification_channel_pauses`);
});

test("a deadline or idle warning that no longer applies is not sent", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = fakeChannel();

  await clearOutbox();
  fake.users.set(owner.email, "UOWNER");

  const moved = await createEnvelope(owner.id, {
    expiresAt: now + 2 * DAY,
    sentAt: now - 5 * DAY,
  });
  const stillClose = await createEnvelope(owner.id, {
    expiresAt: now + 2 * DAY,
    sentAt: now - 5 * DAY,
  });
  const woken = await createEnvelope(owner.id, { sentAt: now - 10 * DAY });

  await queueConditionEvents(database, {
    expiringDays: 3,
    now,
    stuckDays: 7,
  });
  await expandQueuedEvents(database, depsFor(fake.channel, now));

  // Before the messages go out, the sender moves one deadline, and a signer
  // opens the idle envelope.
  await database.query(`update envelopes set expires_at = $2 where id = $1`, [
    moved,
    now + 20 * DAY,
  ]);
  await recordAuditEvent(
    {
      actorType: "signer",
      createdAt: now + 5,
      envelopeId: woken,
      event: "viewed",
    },
    database,
  );
  await deliverDueDeliveries(database, depsFor(fake.channel, now + 10));

  const outcome = async (envelopeId: string) =>
    (await deliveriesFor(envelopeId))
      .filter((row) => row.targetKind === "user")
      .map((row) => `${row.status}:${row.lastError ?? ""}`);

  assert.deepEqual(await outcome(moved), ["skipped:outdated"]);
  assert.deepEqual(await outcome(woken), ["skipped:outdated"]);
  assert.deepEqual(await outcome(stillClose), ["sent:"]);
});

test("a run that leaves events queued says so, so the caller goes round again", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fake = envOnlyChannel();
  const run = () =>
    runNotificationJob({
      channels: [fake.channel],
      database,
      deadline: Date.now() + 60_000,
      detectConditions: false,
      env: { ...settingsEnv, SLACK_BOT_TOKEN: TOKEN_A },
      now: () => now,
    });

  await clearOutbox();
  // More than one run expands (20 batches of 100), none worth a message.
  await database.query(
    `
      insert into notification_events (
        id, dedupe_key, source, event, payload, created_at, queued_at
      )
      select gen_random_uuid()::text, $1 || n::text, 'audit',
        'not_announced', '{}'::jsonb, $2, $2
      from generate_series(1, 2050) as n
    `,
    [`backlog:${marker}:`, now],
  );

  const first = await run();

  assert.equal(first.status, "ran");
  assert.ok(first.status === "ran" && first.eventsProcessed === 2000);
  assert.ok(first.status === "ran" && first.stoppedEarly);

  const second = await run();

  assert.ok(second.status === "ran" && second.eventsProcessed === 50);
  assert.ok(second.status === "ran" && !second.stoppedEarly);

  await database.query(
    `delete from notification_events where dedupe_key like $1`,
    [`backlog:${marker}:%`],
  );
});
