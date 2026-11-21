import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { createApiKey } from "../api-keys.ts";
import {
  apiCreateEnvelopeSchema,
  createEnvelopeForApi,
  type ApiActor,
} from "../api/envelopes.ts";
import { getApiEnvelopeWithOwner } from "../api/envelope-view.ts";
import { withTransaction } from "../db/connection.ts";
import {
  needsPostgresLocks,
  openTestDatabase,
  waitUntilBlockedBy,
} from "../db/test-database.ts";
import { recordAuditEvent } from "../services/audit.ts";
import { issueSigningLink } from "../services/signing-links.ts";
import { getSigningPayloadForToken } from "../signing.ts";
import {
  drainWebhookDeliveries,
  hasDueWebhookDeliveries,
  MAX_ATTEMPTS,
  sendTestWebhook,
} from "./deliver.ts";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  WebhookEndpointError,
} from "./endpoints.ts";
import {
  deleteOldWebhookDeliveries,
  listApiWebhookDeliveries,
  resendWebhookDelivery,
} from "./log.ts";
import type { WebhookEventType } from "./events.ts";
import {
  releaseSentWebhook,
  SENT_HOLD_SECONDS,
  setWebhookDrainScheduler,
} from "./outbox.ts";
import { verifyWebhook } from "./signing.ts";

// Webhooks against a real Postgres and a real HTTP receiver on this
// machine. Run with `npm run test:db`.

const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;

type Received = { body: string; headers: IncomingHttpHeaders };

let database: pg.Pool;
let workDir: string;
let pdf: Uint8Array;
let server: Server;
let receiverUrl: string;
let answer: (received: Received) => number | Promise<number> = () => 200;
const received: Received[] = [];
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();
let env: Record<string, string | undefined>;

before(async () => {
  database = await openTestDatabase();
  // Endpoints left by a run that stopped part way would count toward the
  // cap of 10, so start from none, as afterEach leaves it.
  await database.query(`delete from webhook_endpoints`);
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-webhooks-"));

  for (const name of SETTINGS) {
    settingsBefore.set(name, process.env[name]);
  }

  process.env.APP_URL = "http://localhost:3000";
  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
  process.env.EMAIL_CAPTURE_DIR = path.join(workDir, "outbox");
  process.env.EMAIL_DRIVER = "capture";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = path.join(workDir, "storage");
  env = { ...process.env, VERCEL: undefined, WEBHOOK_ALLOW_PRIVATE_URLS: "1" };

  // The tests send when they choose to.
  setWebhookDrainScheduler(() => undefined);

  const document = await PDFDocument.create();

  document.addPage([612, 792]);
  pdf = await document.save();

  server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
      };

      received.push(entry);
      void Promise.resolve(answer(entry)).then((status) => {
        response.writeHead(status, { "content-type": "text/plain" });
        response.end(status >= 300 ? "receiver says no" : "ok");
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hooks`;
});

afterEach(async () => {
  await database.query(`delete from webhook_endpoints`);
  received.length = 0;
  answer = () => 200;
});

after(async () => {
  setWebhookDrainScheduler(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();

  for (const [name, value] of settingsBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await rm(workDir, { force: true, recursive: true });
});

async function createAdmin(role = "admin"): Promise<ApiActor> {
  const userId = randomUUID();
  const email = `${userId}@example.test`;

  createdUsers.push(userId);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, 'Ops Admin', $2, $3, true)
    `,
    [userId, email, role],
  );

  if (role !== "admin") {
    return {
      apiKeyId: "",
      email,
      ipAddress: null,
      name: "Ops",
      userAgent: null,
      userId,
    };
  }

  const { summary } = await createApiKey(
    { email, userId },
    { expiresInDays: null, name: "Billing app", scope: "write" },
    database,
  );

  return {
    apiKeyId: summary.id,
    email,
    ipAddress: null,
    name: "Ops Admin",
    userAgent: null,
    userId,
  };
}

function createRequest(send = true) {
  return apiCreateEnvelopeSchema.parse({
    fields: [
      {
        height: 0.05,
        page: 1,
        signer: "client",
        type: "signature",
        width: 0.3,
        x: 0.1,
        y: 0.8,
      },
    ],
    metadata: { invoice: "INV-7" },
    signers: [
      { email: "client@example.test", name: "Casey Client", ref: "client" },
    ],
    title: "Service agreement",
    ...(send ? { send: { permittedUseConfirmed: true } } : {}),
  });
}

async function createEnvelope(actor: ApiActor, send = true) {
  return createEnvelopeForApi(
    actor,
    createRequest(send),
    { body: pdf, contentType: "application/pdf", filename: "a.pdf" },
    database,
  );
}

async function addEndpoint(
  actor: ApiActor,
  events: WebhookEventType[] = ["envelope.sent", "envelope.voided"],
) {
  return createWebhookEndpoint(
    actor,
    { description: "Billing", events, url: receiverUrl },
    { database, env },
  );
}

async function deliveriesFor(endpointId: string) {
  return (
    await database.query<{
      attempts: number;
      eventType: string;
      id: string;
      lastError: string | null;
      lastStatusCode: number | null;
      nextAttemptAt: number | null;
      payload: string | null;
      status: string;
    }>(
      `
        select id, event_type as "eventType", status, attempts, payload,
          next_attempt_at as "nextAttemptAt", last_status_code as "lastStatusCode",
          last_error as "lastError"
        from webhook_deliveries where endpoint_id = $1 order by created_at, id
      `,
      [endpointId],
    )
  ).rows;
}

test("only an administrator can add an endpoint, and its URL must be usable", async () => {
  const user = await createAdmin("user");

  await assert.rejects(
    createWebhookEndpoint(
      user,
      { description: "", events: ["envelope.sent"], url: receiverUrl },
      { database, env },
    ),
    (error: unknown) =>
      error instanceof WebhookEndpointError && error.statusCode === 403,
  );

  const admin = await createAdmin();

  await assert.rejects(
    createWebhookEndpoint(
      admin,
      { description: "", events: ["envelope.sent"], url: receiverUrl },
      // Without the development switch, a local URL is refused.
      { database, env: { ...env, WEBHOOK_ALLOW_PRIVATE_URLS: undefined } },
    ),
    (error: unknown) =>
      error instanceof WebhookEndpointError && error.statusCode === 400,
  );

  const { endpoint, secret } = await addEndpoint(admin);

  assert.match(secret, /^whsec_/);
  assert.equal(endpoint.url, receiverUrl);

  const trail = await database.query<{ event: string }>(
    `
      select event from system_audit_events
      where actor_user_id = $1 order by sequence
    `,
    [admin.userId],
  );

  assert.ok(trail.rows.some((row) => row.event === "webhook_endpoint_created"));
  // The secret is never stored in the clear.
  const stored = await database.query<{ secret: string }>(
    `select secret_encrypted as secret from webhook_endpoints where id = $1`,
    [endpoint.id],
  );

  assert.ok(!stored.rows[0]!.secret.includes(secret.slice(6)));
});

test("a delivery is written with its audit event, and not when that rolls back", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin, ["envelope.voided"]);
  const envelope = await createEnvelope(admin);

  // envelope.sent is not one of this endpoint's events.
  assert.equal((await deliveriesFor(endpoint.id)).length, 0);

  await assert.rejects(
    withTransaction(async (tx) => {
      await recordAuditEvent(
        {
          actorType: "sender",
          envelopeId: envelope.id,
          event: "voided",
          metadata: { reason: "never happened" },
        },
        tx,
      );
      // Queued inside the transaction...
      const inside = await tx.query(
        `select 1 from webhook_deliveries where endpoint_id = $1`,
        [endpoint.id],
      );

      assert.equal(inside.rowCount, 1);
      throw new Error("roll back");
    }, database),
    // ...and only this deliberate failure undoes it, not another one.
    (error: unknown) => error instanceof Error && error.message === "roll back",
  );
  // ...and gone with it.
  assert.equal((await deliveriesFor(endpoint.id)).length, 0);

  await recordAuditEvent(
    {
      actorType: "sender",
      envelopeId: envelope.id,
      event: "voided",
      metadata: { reason: "Wrong client" },
    },
    database,
  );

  const rows = await deliveriesFor(endpoint.id);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.eventType, "envelope.voided");
  assert.equal(rows[0]!.status, "pending");
  assert.equal(rows[0]!.payload, null);

  // A disabled endpoint gets nothing new.
  await updateWebhookEndpoint(
    admin,
    endpoint.id,
    { enabled: false },
    { database, env },
  );
  await recordAuditEvent(
    { actorType: "sender", envelopeId: envelope.id, event: "voided" },
    database,
  );
  assert.equal((await deliveriesFor(endpoint.id)).length, 1);
});

test(
  "an endpoint removed while an event is recorded is skipped, and the change still goes through",
  needsPostgresLocks,
  async () => {
    const admin = await createAdmin();
    const { endpoint } = await addEndpoint(admin, ["envelope.voided"]);
    const envelope = await createEnvelope(admin);
    const remover = await database.connect();
    let recorded: Promise<unknown> | undefined;

    try {
      // An administrator removes the endpoint, not yet committed, just as
      // the envelope changes (here a void, as a signature would be).
      await remover.query("begin");
      await remover.query(`delete from webhook_endpoints where id = $1`, [
        endpoint.id,
      ]);

      recorded = recordAuditEvent(
        {
          actorType: "sender",
          envelopeId: envelope.id,
          event: "voided",
          metadata: { reason: "Wrong client" },
        },
        database,
      );
      // Handled at once, so a failure before it waits is reported below
      // instead of as an unhandled rejection.
      recorded.catch(() => undefined);

      await waitUntilBlockedBy(database, remover);
      await remover.query("commit");
    } finally {
      // A no-op after the commit; otherwise the removal is let go, so the
      // event can finish and the connection goes back clean.
      await remover.query("rollback").catch(() => undefined);
      await recorded?.catch(() => undefined);
      remover.release();
    }

    // The change goes through; before, it failed on the foreign key.
    await recorded;

    assert.equal((await deliveriesFor(endpoint.id)).length, 0);

    const voided = await database.query(
      `select 1 from audit_events where envelope_id = $1 and event = 'voided'`,
      [envelope.id],
    );

    assert.equal(voided.rowCount, 1);
  },
);

test("a payload reads the envelope and its signers on one snapshot", async () => {
  const admin = await createAdmin();
  const envelope = await createEnvelope(admin);
  let signedBetween = false;

  // Right after the envelope row is read, the signer signs and that
  // commits on another connection, before the signers are read.
  const signAfterEnvelopeRead = <T extends object>(executor: T): T =>
    new Proxy(executor, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);

        if (property === "query" && typeof value === "function") {
          return async (...args: unknown[]) => {
            const result: unknown = await (
              value as (...queryArgs: unknown[]) => Promise<unknown>
            ).apply(target, args);
            const text = typeof args[0] === "string" ? args[0] : "";

            if (
              !signedBetween &&
              text.includes('JOIN "user" u ON u.id = e.user_id')
            ) {
              signedBetween = true;
              await database.query(
                `update signers set status = 'signed', signed_at = $2 where envelope_id = $1`,
                [envelope.id, Math.floor(Date.now() / 1000)],
              );
            }

            return result;
          };
        }

        if (property === "connect" && typeof value === "function") {
          return async () =>
            signAfterEnvelopeRead(
              await (value as () => Promise<pg.PoolClient>).apply(target),
            );
        }

        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const found = await getApiEnvelopeWithOwner(
    envelope.id,
    signAfterEnvelopeRead(database),
  );

  assert.equal(signedBetween, true);
  assert.equal(found?.envelope.status, "sent");
  // The signing committed after the snapshot, so it is not half in it.
  assert.deepEqual(
    found?.envelope.signers.map((signer) => signer.status),
    ["notified"],
  );
});

test("a delivery is signed, carries the envelope, and is marked delivered", async () => {
  const admin = await createAdmin();
  const { endpoint, secret } = await addEndpoint(admin);
  const envelope = await createEnvelope(admin);
  const summary = await drainWebhookDeliveries({ database, env });

  assert.equal(summary.delivered, 1);
  assert.equal(received.length, 1);

  const [delivery] = received;
  const id = delivery!.headers["webhook-id"] as string;
  const timestamp = Number(delivery!.headers["webhook-timestamp"]);

  assert.match(id, /^msg_[0-9a-f]{32}$/);
  assert.ok(
    verifyWebhook(secret, {
      body: delivery!.body,
      id,
      signatureHeader: delivery!.headers["webhook-signature"] as string,
      timestamp,
    }),
  );

  const body = JSON.parse(delivery!.body) as {
    data: {
      envelope: { id: string; metadata: unknown; status: string };
      owner: { email: string; id: string };
    };
    type: string;
  };

  assert.equal(body.type, "envelope.sent");
  assert.equal(body.data.envelope.id, envelope.id);
  assert.equal(body.data.envelope.status, "sent");
  assert.deepEqual(body.data.envelope.metadata, { invoice: "INV-7" });
  assert.equal(body.data.owner.id, admin.userId);

  const [row] = await deliveriesFor(endpoint.id);

  assert.equal(row!.status, "delivered");
  assert.equal(row!.lastStatusCode, 200);
  assert.equal(row!.id, id);
});

test("a failed try is retried later with the same payload, then given up", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);

  answer = () => 503;
  await createEnvelope(admin);
  await drainWebhookDeliveries({ database, env });

  let [row] = await deliveriesFor(endpoint.id);
  const now = Math.floor(Date.now() / 1000);

  assert.equal(row!.status, "pending");
  assert.equal(row!.attempts, 1);
  assert.equal(row!.lastStatusCode, 503);
  assert.match(row!.lastError ?? "", /503/);
  assert.ok(row!.nextAttemptAt! >= now + 55 && row!.nextAttemptAt! <= now + 65);

  // Not due yet: nothing is sent.
  await drainWebhookDeliveries({ database, env });
  assert.equal(received.length, 1);

  // The last try is due, and fails too.
  await database.query(
    `update webhook_deliveries set attempts = $2, next_attempt_at = 0 where id = $1`,
    [row!.id, MAX_ATTEMPTS - 1],
  );
  await drainWebhookDeliveries({ database, env });
  [row] = await deliveriesFor(endpoint.id);

  assert.equal(received.length, 2);
  assert.equal(received[0]!.body, received[1]!.body);
  assert.equal(
    received[0]!.headers["webhook-id"],
    received[1]!.headers["webhook-id"],
  );
  assert.equal(row!.status, "failed");
  assert.equal(row!.nextAttemptAt, null);

  // "Send again" gives it a full set of tries.
  answer = () => 204;
  assert.ok(await resendWebhookDelivery(row!.id, database));
  await drainWebhookDeliveries({ database, env });
  [row] = await deliveriesFor(endpoint.id);
  assert.equal(row!.status, "delivered");
  assert.equal(row!.attempts, 1);

  // Sent again once delivered, it no longer reads as delivered until it is.
  assert.ok(await resendWebhookDelivery(row!.id, database));

  const reset = await database.query(
    `
      select status, delivered_at as "deliveredAt",
        last_status_code as "lastStatusCode"
      from webhook_deliveries where id = $1
    `,
    [row!.id],
  );

  assert.deepEqual(reset.rows[0], {
    deliveredAt: null,
    lastStatusCode: null,
    status: "pending",
  });
});

test("a last try that never finished is marked failed, not sent again", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);

  await createEnvelope(admin);

  const [row] = await deliveriesFor(endpoint.id);

  // As if a drain claimed the last try and its function then stopped.
  await database.query(
    `
      update webhook_deliveries
      set attempts = $2, next_attempt_at = 0, locked_until = $3
      where id = $1
    `,
    [row!.id, MAX_ATTEMPTS, Math.floor(Date.now() / 1000) - 1],
  );
  assert.equal(await hasDueWebhookDeliveries(database), false);
  await drainWebhookDeliveries({ database, env });

  const [after] = await deliveriesFor(endpoint.id);

  assert.equal(received.length, 0);
  assert.equal(after!.status, "failed");
  assert.match(after!.lastError ?? "", /did not finish/);
});

test("deliveries waiting for an endpoint that is off are not due", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);

  await createEnvelope(admin);
  assert.equal(await hasDueWebhookDeliveries(database), true);

  await updateWebhookEndpoint(
    admin,
    endpoint.id,
    { enabled: false },
    { database, env },
  );
  assert.equal(await hasDueWebhookDeliveries(database), false);
});

test("two drains at once never send the same delivery twice", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);

  for (let index = 0; index < 6; index += 1) {
    await createEnvelope(admin);
  }

  answer = () => new Promise((resolve) => setTimeout(() => resolve(200), 50));

  const [first, second] = await Promise.all([
    drainWebhookDeliveries({ database, env }),
    drainWebhookDeliveries({ database, env }),
  ]);

  assert.equal(first.delivered + second.delivered, 6);
  assert.equal(received.length, 6);
  assert.equal(
    new Set(received.map((entry) => entry.headers["webhook-id"])).size,
    6,
  );
  assert.ok(
    (await deliveriesFor(endpoint.id)).every(
      (row) => row.status === "delivered",
    ),
  );
});

test("a send whose invitation email fails leaves no envelope.sent webhook", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);
  const outbox = process.env.EMAIL_CAPTURE_DIR;
  const { writeFile } = await import("node:fs/promises");
  const blocker = path.join(workDir, "not-a-directory");

  // Capturing the email fails: its folder is a file.
  await writeFile(blocker, "");
  process.env.EMAIL_CAPTURE_DIR = path.join(blocker, "outbox");

  try {
    // The capture's own error, so the send got as far as the email.
    await assert.rejects(
      createEnvelope(admin),
      (error: unknown) => (error as { code?: unknown }).code === "ENOTDIR",
    );
  } finally {
    process.env.EMAIL_CAPTURE_DIR = outbox;
  }

  assert.equal((await deliveriesFor(endpoint.id)).length, 0);
  await drainWebhookDeliveries({ database, env });
  assert.equal(received.length, 0);
});

test("a delivery whose audit event was taken back is dropped", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin, ["envelope.voided"]);
  const envelope = await createEnvelope(admin);
  const event = await recordAuditEvent(
    { actorType: "sender", envelopeId: envelope.id, event: "voided" },
    database,
  );

  await database.query(`delete from audit_events where id = $1`, [event.id]);
  assert.equal((await drainWebhookDeliveries({ database, env })).dropped, 1);
  assert.equal(received.length, 0);
  assert.equal((await deliveriesFor(endpoint.id))[0]!.status, "failed");
});

test("a delivery for an envelope deleted before its first try is dropped", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);
  const envelope = await createEnvelope(admin);

  await database.query(`delete from envelopes where id = $1`, [envelope.id]);
  assert.deepEqual(await drainWebhookDeliveries({ database, env }), {
    delivered: 0,
    dropped: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(received.length, 0);
  assert.equal((await deliveriesFor(endpoint.id))[0]!.status, "failed");
});

test("after a rotation both secrets sign, and an unreadable secret says so", async () => {
  const admin = await createAdmin();
  const { endpoint, secret: oldSecret } = await addEndpoint(admin);
  const { secret: newSecret } = await rotateWebhookSecret(admin, endpoint.id, {
    database,
    env,
  });

  await createEnvelope(admin);
  await drainWebhookDeliveries({ database, env });

  const [delivery] = received;
  const check = (secret: string) =>
    verifyWebhook(secret, {
      body: delivery!.body,
      id: delivery!.headers["webhook-id"] as string,
      signatureHeader: delivery!.headers["webhook-signature"] as string,
      timestamp: Number(delivery!.headers["webhook-timestamp"]),
    });

  assert.ok(check(newSecret));
  assert.ok(check(oldSecret));

  // As if BETTER_AUTH_SECRET had changed since.
  await createEnvelope(admin);
  await drainWebhookDeliveries({
    database,
    env: {
      ...env,
      BETTER_AUTH_SECRET: "a-different-secret-entirely-0123456789",
    },
  });

  const rows = await deliveriesFor(endpoint.id);

  assert.equal(received.length, 1);
  assert.match(
    rows.find((row) => row.status !== "delivered")?.lastError ?? "",
    /Rotate/,
  );
});

test("a second new secret waits until the old one's day is over", async () => {
  const admin = await createAdmin();
  const { endpoint, secret: first } = await addEndpoint(admin);

  await rotateWebhookSecret(admin, endpoint.id, { database, env });
  await assert.rejects(
    rotateWebhookSecret(admin, endpoint.id, { database, env }),
    (error: unknown) =>
      error instanceof WebhookEndpointError &&
      error.statusCode === 409 &&
      /old secret still signs until/.test(error.message),
  );

  // The secret from before the switch-over still signs.
  await createEnvelope(admin);
  await drainWebhookDeliveries({ database, env });

  const [delivery] = received;

  assert.ok(
    verifyWebhook(first, {
      body: delivery!.body,
      id: delivery!.headers["webhook-id"] as string,
      signatureHeader: delivery!.headers["webhook-signature"] as string,
      timestamp: Number(delivery!.headers["webhook-timestamp"]),
    }),
  );

  // Once that day is over, another new secret can be made.
  await database.query(
    `update webhook_endpoints set previous_secret_expires_at = $2 where id = $1`,
    [endpoint.id, Math.floor(Date.now() / 1000) - 1],
  );

  const again = await rotateWebhookSecret(admin, endpoint.id, {
    database,
    env,
  });

  assert.ok(again.secret.startsWith("whsec_"));
});

test("a test event is sent at once, tried once, and left out of the API list", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);

  answer = () => 500;

  const result = await sendTestWebhook(endpoint.id, { database, env });

  assert.equal(result.status, "failed");
  assert.equal(result.lastStatusCode, 500);
  assert.equal(JSON.parse(received[0]!.body).type, "webhook.test");

  answer = () => 200;
  await createEnvelope(admin);
  await drainWebhookDeliveries({ database, env });

  const page = await listApiWebhookDeliveries({ limit: 100 }, database);

  assert.ok(page);
  assert.ok(page.data.every((delivery) => delivery.type !== "webhook.test"));
  assert.ok(
    page.data.some(
      (delivery) =>
        delivery.endpointId === endpoint.id &&
        delivery.type === "envelope.sent" &&
        delivery.status === "delivered",
    ),
  );
  assert.equal(
    await listApiWebhookDeliveries({ cursor: "nonsense", limit: 10 }, database),
    null,
  );
  // Too large for Postgres: refused, not a server error.
  assert.equal(
    await listApiWebhookDeliveries(
      {
        cursor: Buffer.from("100000000000000000000:msg_x").toString(
          "base64url",
        ),
        limit: 10,
      },
      database,
    ),
    null,
  );
});

test("the API list pages with a cursor", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);

  for (let index = 0; index < 3; index += 1) {
    await createEnvelope(admin);
  }

  const ours = (await deliveriesFor(endpoint.id)).map((row) => row.id);

  assert.equal(ours.length, 3);

  // The list is install-wide, so other tests' deliveries are in it too:
  // page through all of it. Every page has something, a page that points
  // to another is full, and the last points nowhere.
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = await listApiWebhookDeliveries(
      { cursor, limit: 2, type: "envelope.sent" },
      database,
    );

    assert.ok(page);
    assert.ok(page.data.length > 0, "a page came back empty");

    if (page.nextCursor) {
      assert.equal(page.data.length, 2);
    }

    seen.push(...page.data.map((delivery) => delivery.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor !== undefined && pages < 10_000);

  assert.equal(cursor, undefined);
  assert.ok(pages >= 2);
  assert.equal(new Set(seen).size, seen.length);

  for (const id of ours) {
    assert.ok(seen.includes(id), `delivery ${id} was not listed`);
  }
});

test("old deliveries are cleared, failed ones kept longer, and endpoints removed with their log", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);

  await createEnvelope(admin);
  await createEnvelope(admin);

  const [delivered, failed] = await deliveriesFor(endpoint.id);
  const now = Math.floor(Date.now() / 1000);
  const day = 24 * 60 * 60;

  await database.query(
    `
      update webhook_deliveries
      set status = 'delivered', created_at = $2, delivered_at = $2, updated_at = $2
      where id = $1
    `,
    [delivered!.id, now - 31 * day],
  );
  await database.query(
    `
      update webhook_deliveries
      set status = 'failed', created_at = $2, updated_at = $2
      where id = $1
    `,
    [failed!.id, now - 31 * day],
  );
  assert.equal(await deleteOldWebhookDeliveries(database, now), 1);
  assert.equal((await deliveriesFor(endpoint.id)).length, 1);
  assert.equal(await deleteOldWebhookDeliveries(database, now + 58 * day), 0);

  // Sent again, it keeps its retries however old its event is: the 90 days
  // count from its last change.
  assert.ok(await resendWebhookDelivery(failed!.id, database, now));
  assert.equal(await deleteOldWebhookDeliveries(database, now + 60 * day), 0);
  assert.equal(await deleteOldWebhookDeliveries(database, now + 91 * day), 1);

  await createEnvelope(admin);
  await deleteWebhookEndpoint(admin, endpoint.id, database);
  assert.equal((await deliveriesFor(endpoint.id)).length, 0);
});

test("envelope.sent waits, unclaimable, until the invitation is out", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin, ["envelope.sent"]);
  const envelope = await createEnvelope(admin, false);

  // What sendDraftEnvelope writes when it marks the envelope sent, before
  // the email goes.
  await withTransaction(
    (tx) =>
      recordAuditEvent(
        { actorType: "sender", envelopeId: envelope.id, event: "sent" },
        tx,
      ),
    database,
  );

  const [held] = await deliveriesFor(endpoint.id);
  const now = Math.floor(Date.now() / 1000);

  assert.ok(held!.nextAttemptAt! >= now + SENT_HOLD_SECONDS - 5);
  // Any drain meanwhile, from another request or the cron, takes nothing.
  assert.equal((await drainWebhookDeliveries({ database, env })).delivered, 0);
  assert.equal(received.length, 0);

  await releaseSentWebhook(envelope.id, database);
  assert.equal((await drainWebhookDeliveries({ database, env })).delivered, 1);
  assert.equal(received.length, 1);
});

test("a try that outlived its lease cannot overwrite the newer try's result", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);

  await createEnvelope(admin);

  let releaseFirst: (status: number) => void = () => undefined;

  answer = () =>
    received.length === 1
      ? new Promise<number>((resolve) => {
          releaseFirst = resolve;
        })
      : 200;

  // The first drain sends and hangs waiting for the receiver.
  let staleFinished = false;
  const stale = drainWebhookDeliveries({ database, env }).finally(() => {
    staleFinished = true;
  });
  const deadline = Date.now() + 5_000;

  while (received.length < 1 && !staleFinished && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(
    received.length,
    1,
    "the first request never reached the receiver",
  );

  // Its lease runs out; a newer drain takes the delivery and succeeds.
  await database.query(
    `update webhook_deliveries set locked_until = 0 where endpoint_id = $1`,
    [endpoint.id],
  );
  assert.equal((await drainWebhookDeliveries({ database, env })).delivered, 1);

  // Then the stale one hears back with a failure, and must change nothing.
  releaseFirst(500);
  await stale;

  const [row] = await deliveriesFor(endpoint.id);

  assert.equal(received.length, 2);
  assert.equal(received[0]!.body, received[1]!.body);
  assert.equal(row!.status, "delivered");
  assert.equal(row!.lastStatusCode, 200);
});

test("a retry is dropped once its envelope is deleted, even after a first try", async () => {
  const admin = await createAdmin();
  const { endpoint } = await addEndpoint(admin);
  const envelope = await createEnvelope(admin);

  answer = () => 503;
  await drainWebhookDeliveries({ database, env });

  const [tried] = await deliveriesFor(endpoint.id);

  assert.equal(tried!.status, "pending");
  assert.ok(tried!.payload);

  await database.query(`delete from envelopes where id = $1`, [envelope.id]);
  await database.query(
    `update webhook_deliveries set next_attempt_at = 0 where id = $1`,
    [tried!.id],
  );
  assert.equal((await drainWebhookDeliveries({ database, env })).dropped, 1);
  assert.equal(received.length, 1);

  // "Send again" does not bring it back either.
  assert.ok(await resendWebhookDelivery(tried!.id, database));
  assert.equal((await drainWebhookDeliveries({ database, env })).dropped, 1);
  assert.equal(received.length, 1);
});

test("two first openings at once record one view and queue one signer.viewed", async () => {
  const actor = await createAdmin();
  const endpoint = await addEndpoint(actor, ["signer.viewed"]);
  const envelope = await createEnvelope(actor);
  const signerId = envelope.signers[0]!.id;
  const link = await issueSigningLink({ expiresInSeconds: 3600 }, { env });

  await database.query(
    `
      update signers set signing_token_hash = $2, signing_token_expires_at = $3
      where id = $1
    `,
    [signerId, link.tokenHash, link.exp],
  );
  await Promise.all(
    Array.from({ length: 4 }, () =>
      getSigningPayloadForToken(link.token, { database }),
    ),
  );

  const views = await database.query<{ count: number }>(
    `
      select count(*)::int as count from audit_events
      where envelope_id = $1 and event = 'viewed'
    `,
    [envelope.id],
  );

  assert.equal(views.rows[0]?.count, 1);
  assert.equal((await deliveriesFor(endpoint.endpoint.id)).length, 1);
});
