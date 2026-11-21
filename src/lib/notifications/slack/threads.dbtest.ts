import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "../../db/test-database.ts";
import { recordAuditEvent } from "../../services/audit.ts";
import {
  deliverDueDeliveries,
  discardQueuedEvents,
  expandQueuedEvents,
  THREAD_BUSY_RETRY_SECONDS,
  type OutboxDeps,
} from "../outbox.ts";
import { createNotificationRule } from "../rules.ts";
import { EMPTY_NOTIFICATION_SETTINGS } from "../store.ts";
import { createSlackChannelWithFetch } from "./channel.ts";
import type { SlackFetch } from "./client.ts";

// One message per envelope per place, against a real Postgres and the real
// Slack channel with a fake Slack: a channel's first post starts a thread
// and later events edit it and reply in it; a sender's progress edits one
// direct message and an outcome posts a new one; a burst of signatures is
// one message; and nobody hears about what they did themselves. Run with
// `npm run test:db`.

const TOKEN = "xoxb-1234567890-threadstest";
const CHANNEL = "C0THREAD1";

let database: pg.Pool;
const createdUsers: string[] = [];
const createdRules: string[] = [];
const marker = `thread${randomUUID().slice(0, 8)}`;

let owner: { email: string; id: string };
let ownerSlackId: string;

type SlackCall = {
  body: Record<string, unknown>;
  method: string;
  /** The ts Slack gave a new message. */
  ts?: string;
};

/** A fake Slack: posts get a new ts; a direct message lands in D<user>. */
function fakeSlack() {
  const calls: SlackCall[] = [];
  let next = 1;
  const fetch: SlackFetch = async (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    const raw = String(init.body ?? "");
    const body =
      method === "users.lookupByEmail"
        ? Object.fromEntries(new URLSearchParams(raw))
        : (JSON.parse(raw) as Record<string, unknown>);

    calls.push({ body, method });

    const reply = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
        status: 200,
      });

    if (method === "users.lookupByEmail") {
      return body.email === owner.email.toLowerCase()
        ? reply({ ok: true, user: { id: ownerSlackId } })
        : reply({ error: "users_not_found", ok: false });
    }

    const channel = String(body.channel);
    const conversation = channel.startsWith("U") ? `D${channel}` : channel;

    if (method === "chat.update") {
      return reply({ channel: conversation, ok: true, ts: body.ts });
    }

    next += 1;

    const ts = `1700000000.${String(next).padStart(6, "0")}`;
    const call = calls.at(-1);

    if (call) {
      call.ts = ts;
    }

    return reply({ channel: conversation, ok: true, ts });
  };

  return { calls, fetch };
}

function depsAt(fetch: SlackFetch, now: number): OutboxDeps {
  return {
    appUrl: "https://sign.example.test",
    brand: { logoUrl: null, name: "Example Org" },
    channels: [createSlackChannelWithFetch(fetch)],
    context: {
      env: { SLACK_BOT_TOKEN: TOKEN },
      stored: EMPTY_NOTIFICATION_SETTINGS,
    },
    now: () => now,
    random: () => 0,
  };
}

/** Sends what is due at `now`, after turning queued events into deliveries. */
async function runAt(fetch: SlackFetch, now: number) {
  const deps = depsAt(fetch, now);

  await expandQueuedEvents(database, deps);

  return deliverDueDeliveries(database, deps);
}

async function createEnvelope(
  signerEmails: string[],
  sentAt: number,
): Promise<{ id: string; signerIds: string[] }> {
  const id = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        created_at, updated_at
      ) values ($1, $2, $3, 'sent', $4, 'contract.pdf', 4, 1, $5, $6, $6, $6)
    `,
    [
      id,
      owner.id,
      `Contract ${marker}`,
      `test/${id}.pdf`,
      "a".repeat(64),
      sentAt,
    ],
  );

  const signerIds: string[] = [];

  for (const [index, email] of signerEmails.entries()) {
    const signerId = randomUUID();

    signerIds.push(signerId);
    await database.query(
      `
        insert into signers (
          id, envelope_id, name, email, sign_order, status
        ) values ($1, $2, $3, $4, $5, $6)
      `,
      [
        signerId,
        id,
        `Signer ${String(index + 1)}`,
        email,
        index + 1,
        // One signer at a time is waiting to sign; the rest come after.
        index === 0 ? "notified" : "pending",
      ],
    );
  }

  return { id, signerIds };
}

async function sign(
  envelope: { id: string; signerIds: string[] },
  index: number,
  email: string,
  at: number,
) {
  await database.query(`update signers set status = 'signed' where id = $1`, [
    envelope.signerIds[index],
  ]);
  await recordAuditEvent(
    {
      actorEmail: email,
      actorType: "signer",
      createdAt: at,
      envelopeId: envelope.id,
      event: "signed",
      metadata: {
        signerEmail: email,
        signerId: envelope.signerIds[index],
        signerName: `Signer ${String(index + 1)}`,
      },
    },
    database,
  );
}

async function deliveries(envelopeId: string) {
  const result = await database.query<{
    attempts: number;
    event: string;
    lastError: string | null;
    nextAttemptAt: number;
    status: string;
    target: string;
    targetKind: string;
  }>(
    `
      select d.target_kind as "targetKind", d.target, d.status, d.attempts,
        d.last_error as "lastError", d.next_attempt_at as "nextAttemptAt",
        e.event
      from notification_deliveries d
      join notification_events e on e.id = d.event_id
      where e.envelope_id = $1
      order by e.created_at, d.target_kind
    `,
    [envelopeId],
  );

  return result.rows;
}

function toChannel(calls: SlackCall[]) {
  return calls.filter(
    (call) => call.method.startsWith("chat.") && call.body.channel === CHANNEL,
  );
}

function toOwner(calls: SlackCall[]) {
  return calls.filter(
    (call) =>
      call.method.startsWith("chat.") &&
      (call.body.channel === ownerSlackId ||
        call.body.channel === `D${ownerSlackId}`),
  );
}

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;

  await discardQueuedEvents(database, Math.floor(Date.now() / 1000));
  await database.query(
    `update notification_deliveries set status = 'skipped'
     where status in ('pending', 'sending')`,
  );

  const id = randomUUID();

  owner = { email: `${id}@example.test`, id };
  ownerSlackId = `U${id.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, 'Sam Sender', $2, true, 'user')
    `,
    [id, owner.email],
  );

  // A rule of this file's own, removed at the end. Queued events were
  // cleared above, so the channel only hears about this file's envelopes.
  const rules = await createNotificationRule(
    { email: owner.email, id: owner.id },
    {
      channel: "slack",
      destination: CHANNEL,
      events: ["envelope_signed", "envelope_completed"],
    },
    database,
  );
  const rule = rules.find((item) => item.destination === CHANNEL);

  assert.ok(rule);
  createdRules.push(rule.id);
});

after(async () => {
  await database.query(`delete from notification_rules where id = any($1)`, [
    createdRules,
  ]);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

test("a channel gets one thread per envelope, and the sender one direct message that follows it", async () => {
  const slack = fakeSlack();
  const now = Math.floor(Date.now() / 1000);
  const emails = ["a@example.test", "b@example.test", "c@example.test"];
  const envelope = await createEnvelope(emails, now);

  // The first signature waits a minute in case more follow.
  await sign(envelope, 0, emails[0] ?? "", now);
  await runAt(slack.fetch, now);
  assert.equal(toChannel(slack.calls).length, 0, "held for a minute");

  await runAt(slack.fetch, now + 61);

  const [parent] = toChannel(slack.calls);

  assert.equal(parent?.method, "chat.postMessage");
  assert.equal(parent?.body.thread_ts, undefined, "it starts the thread");
  assert.match(String(parent?.body.text), /1 of 3 signed/);

  const [firstDm] = toOwner(slack.calls);

  assert.equal(firstDm?.method, "chat.postMessage");
  assert.equal(firstDm?.body.channel, ownerSlackId);

  // A later signature edits the first post and replies in its thread, and
  // edits the sender's direct message in place.
  slack.calls.length = 0;
  await sign(envelope, 1, emails[1] ?? "", now + 120);
  await runAt(slack.fetch, now + 120);
  await runAt(slack.fetch, now + 181);

  const channelCalls = toChannel(slack.calls);

  assert.deepEqual(
    channelCalls.map((call) => call.method),
    ["chat.update", "chat.postMessage"],
  );
  assert.ok(parent?.ts);
  assert.equal(
    channelCalls[0]?.body.ts,
    parent?.ts,
    "the first post is edited",
  );
  assert.equal(channelCalls[1]?.body.thread_ts, parent?.ts, "and replied to");
  assert.match(String(channelCalls[0]?.body.text), /2 of 3 signed/);

  const dmCalls = toOwner(slack.calls);

  assert.deepEqual(
    dmCalls.map((call) => call.method),
    ["chat.update"],
  );
  assert.equal(dmCalls[0]?.body.channel, `D${ownerSlackId}`);
  assert.match(String(dmCalls[0]?.body.text), /2 of 3 signed/);

  // Completed: no wait. The channel's thread gets a reply and its first
  // post the final state; the sender's progress message is brought up to
  // date and a new direct message says it is done.
  slack.calls.length = 0;
  await database.query(
    `update signers set status = 'signed' where envelope_id = $1`,
    [envelope.id],
  );
  await database.query(
    `update envelopes set status = 'completed' where id = $1`,
    [envelope.id],
  );
  await recordAuditEvent(
    {
      actorType: "system",
      createdAt: now + 200,
      envelopeId: envelope.id,
      event: "completed",
    },
    database,
  );
  await runAt(slack.fetch, now + 200);

  assert.deepEqual(
    toChannel(slack.calls).map((call) => call.method),
    ["chat.update", "chat.postMessage"],
  );
  assert.deepEqual(
    toOwner(slack.calls).map((call) => [
      call.method,
      call.body.channel,
      call.body.thread_ts ?? null,
    ]),
    [
      ["chat.update", `D${ownerSlackId}`, null],
      ["chat.postMessage", ownerSlackId, null],
    ],
  );
  assert.match(
    JSON.stringify(toOwner(slack.calls)[1]?.body),
    /View certificate/,
  );

  const thread = await database.query<{
    leaseOwner: string | null;
    messageTs: string | null;
    targetKind: string;
  }>(
    `
      select target_kind as "targetKind", message_ts as "messageTs",
        lease_owner as "leaseOwner"
      from notification_threads where envelope_id = $1
      order by target_kind
    `,
    [envelope.id],
  );

  assert.equal(thread.rowCount, 2);
  assert.ok(thread.rows.every((row) => row.messageTs && !row.leaseOwner));
});

test("several signatures within a minute become one message in each place", async () => {
  const slack = fakeSlack();
  const now = Math.floor(Date.now() / 1000) + 1000;
  const emails = ["d@example.test", "e@example.test", "f@example.test"];
  const envelope = await createEnvelope(emails, now);

  for (const [index, email] of emails.entries()) {
    await sign(envelope, index, email, now + index);
    await runAt(slack.fetch, now + index);
  }

  assert.equal(
    slack.calls.filter((call) => call.method.startsWith("chat.")).length,
    0,
  );

  await runAt(slack.fetch, now + 70);

  const channelCalls = toChannel(slack.calls);
  const dmCalls = toOwner(slack.calls);

  assert.equal(channelCalls.length, 1, "one Slack call to the channel");
  assert.equal(dmCalls.length, 1, "one Slack call to the sender");
  assert.match(String(channelCalls[0]?.body.text), /Signer 3 signed/);
  assert.match(String(channelCalls[0]?.body.text), /3 of 3 signed/);

  const rows = await deliveries(envelope.id);

  assert.equal(rows.filter((row) => row.status === "sent").length, 2);
  assert.equal(
    rows.filter(
      (row) => row.status === "skipped" && row.lastError === "superseded",
    ).length,
    4,
  );
});

test("a sender who signs their own envelope is not told about it; the channel is", async () => {
  const slack = fakeSlack();
  const now = Math.floor(Date.now() / 1000) + 2000;
  const envelope = await createEnvelope([owner.email, "g@example.test"], now);

  await sign(envelope, 0, owner.email, now);
  await runAt(slack.fetch, now);

  const rows = await deliveries(envelope.id);

  assert.deepEqual(
    rows.map((row) => `${row.targetKind}:${row.target}`),
    [`channel:${CHANNEL}`],
  );

  await runAt(slack.fetch, now + 61);
  assert.equal(toOwner(slack.calls).length, 0);
  assert.equal(toChannel(slack.calls).length, 1);
});

test("a delivery waits a moment while another is posting about the same envelope there", async () => {
  const slack = fakeSlack();
  const now = Math.floor(Date.now() / 1000) + 3000;
  const envelope = await createEnvelope(["h@example.test"], now);

  await database.query(
    `update signers set status = 'signed' where envelope_id = $1`,
    [envelope.id],
  );
  await database.query(
    `update envelopes set status = 'completed' where id = $1`,
    [envelope.id],
  );
  await database.query(
    `
      insert into notification_threads (
        envelope_id, channel, target_kind, target, lease_owner, lease_until,
        created_at, updated_at
      ) values ($1, 'slack', 'channel', $2, 'another-run', $3, $4, $4)
    `,
    [envelope.id, CHANNEL, now + 100, now],
  );
  await recordAuditEvent(
    {
      actorType: "system",
      createdAt: now,
      envelopeId: envelope.id,
      event: "completed",
    },
    database,
  );
  await runAt(slack.fetch, now);

  const channelRow = (await deliveries(envelope.id)).find(
    (row) => row.targetKind === "channel",
  );

  assert.equal(channelRow?.status, "pending");
  assert.equal(channelRow?.attempts, 0, "not counted as a try");
  assert.equal(channelRow?.nextAttemptAt, now + THREAD_BUSY_RETRY_SECONDS);
  assert.equal(toChannel(slack.calls).length, 0);

  // Once the other run's lease is over, it goes out.
  await runAt(slack.fetch, now + 101);
  assert.equal(toChannel(slack.calls).length, 1);
});

test("two events in the same second are ordered as they happened, not by their ids", async () => {
  const slack = fakeSlack();
  const now = Math.floor(Date.now() / 1000) + 4000;
  const envelope = await createEnvelope(["i@example.test"], now);

  await sign(envelope, 0, "i@example.test", now);
  await database.query(
    `update envelopes set status = 'completed' where id = $1`,
    [envelope.id],
  );
  await recordAuditEvent(
    {
      actorType: "system",
      createdAt: now,
      envelopeId: envelope.id,
      event: "completed",
    },
    database,
  );
  // Ids are random. Make the completed event's sort lower than the signed
  // one's, the way they do about half the time.
  await database.query(
    `update notification_events set id = $2 where envelope_id = $1 and event = 'signed'`,
    [envelope.id, "zzzzzzzz-signed"],
  );
  await database.query(
    `update notification_events set id = $2 where envelope_id = $1 and event = 'completed'`,
    [envelope.id, "aaaaaaaa-completed"],
  );

  // The completion goes out at once; the signature was held a minute.
  await runAt(slack.fetch, now);

  const callsAfterCompleted = toChannel(slack.calls).length;

  assert.equal(callsAfterCompleted, 1);

  await runAt(slack.fetch, now + 61);

  const signed = (await deliveries(envelope.id)).find(
    (row) => row.event === "signed" && row.targetKind === "channel",
  );

  assert.equal(signed?.status, "skipped");
  assert.equal(signed?.lastError, "superseded");
  assert.equal(
    toChannel(slack.calls).length,
    callsAfterCompleted,
    "the thread was not edited back to the signature",
  );
});
