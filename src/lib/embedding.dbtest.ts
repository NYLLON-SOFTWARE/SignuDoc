import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { createApiKey } from "./api-keys.ts";
import {
  apiCreateEnvelopeSchema,
  createEnvelopeForApi,
  type ApiActor,
} from "./api/envelopes.ts";
import {
  needsPostgresLocks,
  openTestDatabase,
  waitUntilBlockedBy,
} from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import {
  addEmbedOrigin,
  EmbeddingError,
  issueEmbedLink,
  listEmbedOrigins,
  openEmbedLink,
  readEmbedEvidence,
  removeEmbedOrigin,
} from "./embedding.ts";
import {
  changeEnvelopeDeadline,
  correctSentEnvelopeSigner,
  EnvelopeMutationError,
} from "./envelopes.ts";
import { ReminderMutationError, sendManualEnvelopeNudge } from "./reminders.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import {
  declineSigningForToken,
  getSigningPayloadForToken,
  recordSignerConsent,
  SigningAccessError,
  SigningMutationError,
  submitSigningForToken,
} from "./signing.ts";
import { setWebhookDrainScheduler } from "./webhooks/outbox.ts";

// Embedded signing against a real Postgres and real files. Run with
// `npm run test:db`.

const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;
const ORIGIN = "https://app.example.com";
// A PNG of one transparent pixel, standing in for a drawn signature.
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let database: pg.Pool;
let workDir: string;
let pdf: Uint8Array;
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  database = await openTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-embed-"));

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
  setWebhookDrainScheduler(() => undefined);

  const document = await PDFDocument.create();

  document.addPage([612, 792]);
  pdf = await document.save();
  // The end-to-end run shares this database and leaves its site behind.
  await database.query(`delete from embed_allowed_origins`);
});

afterEach(async () => {
  await database.query(`delete from embed_allowed_origins`);
});

after(async () => {
  setWebhookDrainScheduler(null);
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

async function createAdmin(): Promise<ApiActor> {
  const userId = randomUUID();
  const email = `${userId}@example.test`;

  createdUsers.push(userId);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, 'Ops Admin', $2, 'admin', true)
    `,
    [userId, email],
  );

  const { summary } = await createApiKey(
    { email, userId },
    { expiresInDays: null, name: "Portal", scope: "write" },
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

function request(options: { accessCode?: string; delivery?: string } = {}) {
  const tag = randomUUID().slice(0, 8);

  return apiCreateEnvelopeSchema.parse({
    fields: [
      {
        height: 0.05,
        page: 1,
        signer: "a",
        type: "signature",
        width: 0.3,
        x: 0.1,
        y: 0.7,
      },
      {
        height: 0.05,
        page: 1,
        signer: "b",
        type: "signature",
        width: 0.3,
        x: 0.5,
        y: 0.7,
      },
    ],
    send: {
      delivery: options.delivery ?? "embedded",
      permittedUseConfirmed: true,
    },
    signers: [
      {
        email: `first-${tag}@example.test`,
        name: "First Signer",
        ref: "a",
        ...(options.accessCode ? { accessCode: options.accessCode } : {}),
      },
      { email: `second-${tag}@example.test`, name: "Second Signer", ref: "b" },
    ],
    title: "Portal agreement",
  });
}

async function create(
  actor: ApiActor,
  options?: Parameters<typeof request>[0],
) {
  return createEnvelopeForApi(
    actor,
    request(options),
    { body: pdf, contentType: "application/pdf", filename: "a.pdf" },
    database,
  );
}

async function invitationsTo(email: string): Promise<number> {
  const dir = process.env.EMAIL_CAPTURE_DIR!;
  // No outbox yet means nothing was sent; any other failure must not pass
  // for an empty one.
  const files = await readdir(dir).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") {
      return [] as string[];
    }

    throw error;
  });
  let count = 0;

  for (const file of files) {
    const message = JSON.parse(
      await readFile(path.join(dir, file), "utf8"),
    ) as {
      template?: string;
      to?: string | string[];
    };

    if (
      message.template === "signing_invitation" &&
      [message.to].flat().includes(email)
    ) {
      count += 1;
    }
  }

  return count;
}

function tokenOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
}

test("only an administrator lists sites, and only exact https origins", async () => {
  const admin = await createAdmin();

  await assert.rejects(
    addEmbedOrigin(admin, "https://app.example.com/path", { database }),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 400,
  );
  assert.equal(
    await addEmbedOrigin(admin, "https://App.Example.com/", { database }),
    ORIGIN,
  );
  // Adding it again changes nothing.
  await addEmbedOrigin(admin, ORIGIN, { database });
  assert.deepEqual(
    (await listEmbedOrigins(database)).map((row) => row.origin),
    [ORIGIN],
  );

  await database.query(`update public."user" set role = 'user' where id = $1`, [
    admin.userId,
  ]);
  await assert.rejects(
    removeEmbedOrigin(admin, ORIGIN, database),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 403,
  );
});

test("an embedded send is refused while no site is allowed, or with signer checks", async () => {
  const admin = await createAdmin();

  await assert.rejects(
    create(admin),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /Embedded signing is off/.test(error.message),
  );

  await addEmbedOrigin(admin, ORIGIN, { database });
  await assert.rejects(
    create(admin, { accessCode: "1234" }),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /access codes/.test(error.message),
  );
});

test("an embedded envelope emails no invitation, and the app gets a link for the signer whose turn it is", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const [first, second] = envelope.signers;

  assert.equal(envelope.delivery, "embedded");
  assert.equal(envelope.status, "sent");
  assert.equal(await invitationsTo(first!.email), 0);

  // Not yet the second signer's turn; an unlisted site is refused.
  await assert.rejects(
    issueEmbedLink(
      {
        envelopeId: envelope.id,
        origin: ORIGIN,
        signerId: second!.id,
        userId: admin.userId,
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 409,
  );
  await assert.rejects(
    issueEmbedLink(
      {
        envelopeId: envelope.id,
        origin: "https://other.example.com",
        signerId: first!.id,
        userId: admin.userId,
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 403,
  );
  // Someone else's envelope is not found.
  const stranger = await createAdmin();

  await assert.rejects(
    issueEmbedLink(
      {
        envelopeId: envelope.id,
        origin: ORIGIN,
        signerId: first!.id,
        userId: stranger.userId,
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 404,
  );

  const link = await issueEmbedLink(
    {
      envelopeId: envelope.id,
      origin: ORIGIN,
      signerId: first!.id,
      userId: admin.userId,
    },
    { database },
  );
  const url = new URL(link.url);

  assert.equal(url.searchParams.get("origin"), ORIGIN);
  assert.match(url.pathname, /^\/embed\/sign\//);
  assert.ok(Date.parse(link.expiresAt) - Date.now() <= 15 * 60 * 1000 + 1000);

  const token = tokenOf(link.url);

  assert.deepEqual(
    await openEmbedLink(token, "https://other.example.com", database),
    {
      ok: false,
      reason: "wrong_origin",
    },
  );
  assert.deepEqual(await openEmbedLink(token, ORIGIN, database), { ok: true });

  // Opening it gave it a signing session, not just 15 minutes.
  const expiry = await database.query<{ expiresAt: number }>(
    `select signing_token_expires_at as "expiresAt" from signers where id = $1`,
    [first!.id],
  );

  assert.ok(expiry.rows[0]!.expiresAt - Date.now() / 1000 > 60 * 60);

  const payload = await getSigningPayloadForToken(token, { database });

  assert.equal(payload.signer.id, first!.id);

  // A new link replaces the last one.
  const replacement = await issueEmbedLink(
    {
      envelopeId: envelope.id,
      origin: ORIGIN,
      signerId: first!.id,
      userId: admin.userId,
    },
    { database },
  );

  await assert.rejects(
    getSigningPayloadForToken(token, { database }),
    (error: unknown) =>
      error instanceof SigningAccessError && error.state === "expired",
  );
  assert.ok(
    await getSigningPayloadForToken(tokenOf(replacement.url), { database }),
  );
});

test("signers of an embedded envelope who share a step each get a link, and the next step is not emailed", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const tag = randomUUID().slice(0, 8);
  const signatureFor = (signer: string, x: number) => ({
    height: 0.05,
    page: 1,
    signer,
    type: "signature",
    width: 0.2,
    x,
    y: 0.7,
  });
  const envelope = await createEnvelopeForApi(
    admin,
    apiCreateEnvelopeSchema.parse({
      fields: [
        signatureFor("a", 0.05),
        signatureFor("b", 0.35),
        signatureFor("c", 0.65),
      ],
      send: { delivery: "embedded", permittedUseConfirmed: true },
      signers: [
        {
          email: `first-${tag}@example.test`,
          name: "First",
          ref: "a",
          step: 1,
        },
        {
          email: `second-${tag}@example.test`,
          name: "Second",
          ref: "b",
          step: 1,
        },
        {
          email: `third-${tag}@example.test`,
          name: "Third",
          ref: "c",
          step: 2,
        },
      ],
      title: "Portal agreement",
    }),
    { body: pdf, contentType: "application/pdf", filename: "a.pdf" },
    database,
  );
  const [first, second, third] = envelope.signers;

  assert.deepEqual(
    envelope.signers.map((signer) => signer.status),
    ["notified", "notified", "pending"],
  );

  // Both signers of the first step can have a link at once, and the next
  // step's cannot yet.
  const tokens = [
    await linkFor(admin, envelope.id, first!.id),
    await linkFor(admin, envelope.id, second!.id),
  ];

  await assert.rejects(
    linkFor(admin, envelope.id, third!.id),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 409,
  );

  for (const [index, token] of tokens.entries()) {
    const signerId = [first!.id, second!.id][index]!;
    const field = await database.query<{ id: string }>(
      `select id from fields where envelope_id = $1 and signer_id = $2`,
      [envelope.id, signerId],
    );

    assert.deepEqual(await openEmbedLink(token, ORIGIN, database), {
      ok: true,
    });
    await recordSignerConsent(
      token,
      { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
      { database },
    );
    await submitSigningForToken(
      token,
      {
        clientTimezoneOffsetMinutes: 0,
        fields: [
          {
            fieldId: field.rows[0]!.id,
            imageDataUrl: DRAWN_SIGNATURE,
            inputMethod: "drawn",
            type: "signature",
          },
        ],
      },
      { database },
    );
  }

  // The second step has started, and its signer was not emailed: the app
  // asks for their link.
  const statuses = await database.query<{ status: string }>(
    `select status from signers where id = $1`,
    [third!.id],
  );

  assert.equal(statuses.rows[0]?.status, "notified");
  assert.equal(await invitationsTo(third!.email), 0);
  assert.ok(await linkFor(admin, envelope.id, third!.id));
});

test("an embedded link not opened in time stops working", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const link = await issueEmbedLink(
    {
      envelopeId: envelope.id,
      origin: ORIGIN,
      signerId: envelope.signers[0]!.id,
      userId: admin.userId,
    },
    { database },
  );
  const token = tokenOf(link.url);

  await database.query(
    `update signers set signing_token_expires_at = $2 where signing_token_hash = $1`,
    [hashOpaqueToken(token), Math.floor(Date.now() / 1000) - 1],
  );
  // Opening it late does not bring it back.
  await openEmbedLink(token, ORIGIN, database);
  await assert.rejects(
    getSigningPayloadForToken(token, { database }),
    (error: unknown) =>
      error instanceof SigningAccessError && error.state === "expired",
  );
});

test("an emailed envelope gets no embed links, and an embedded one no reminders or corrections", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const emailed = await create(admin, { delivery: "email" });

  assert.equal(emailed.delivery, "email");
  // The capture check above would see an invitation if one went out.
  assert.equal(await invitationsTo(emailed.signers[0]!.email), 1);
  await assert.rejects(
    issueEmbedLink(
      {
        envelopeId: emailed.id,
        origin: ORIGIN,
        signerId: emailed.signers[0]!.id,
        userId: admin.userId,
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 409,
  );

  const embedded = await create(admin);
  const sender = { senderEmail: admin.email, senderName: admin.name };

  await assert.rejects(
    sendManualEnvelopeNudge(admin.userId, embedded.id, sender, { database }),
    (error: unknown) =>
      error instanceof ReminderMutationError && error.statusCode === 409,
  );
  await assert.rejects(
    correctSentEnvelopeSigner(
      admin.userId,
      embedded.id,
      embedded.signers[0]!.id,
      { email: "new@example.test", name: "New Name" },
      sender,
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 409,
  );
});

async function linkFor(
  admin: ApiActor,
  envelopeId: string,
  signerId: string,
  apiKeyId: string = admin.apiKeyId,
) {
  const link = await issueEmbedLink(
    { apiKeyId, envelopeId, origin: ORIGIN, signerId, userId: admin.userId },
    { database },
  );

  return tokenOf(link.url);
}

async function signerLink(signerId: string) {
  const row = await database.query<{
    expiresAt: number;
    openedAt: number | null;
  }>(
    `
      select signing_token_expires_at as "expiresAt",
        embed_link_opened_at as "openedAt"
      from signers where id = $1
    `,
    [signerId],
  );

  return row.rows[0]!;
}

test("removing a site stops the links made for it, opened or not", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const token = await linkFor(admin, envelope.id, envelope.signers[0]!.id);
  // A second link that is never opened.
  const waiting = await create(admin);
  const unopened = await linkFor(admin, waiting.id, waiting.signers[0]!.id);

  assert.deepEqual(await openEmbedLink(token, ORIGIN, database), { ok: true });
  await removeEmbedOrigin(admin, ORIGIN, database);

  const isExpired = (error: unknown) =>
    error instanceof SigningAccessError && error.state === "expired";

  assert.deepEqual(await openEmbedLink(token, ORIGIN, database), {
    ok: false,
    reason: "wrong_origin",
  });
  await assert.rejects(
    getSigningPayloadForToken(token, { database }),
    isExpired,
  );
  await assert.rejects(
    getSigningPayloadForToken(unopened, { database }),
    isExpired,
  );

  // Adding the site back revives neither old link; a new one works.
  await addEmbedOrigin(admin, ORIGIN, { database });
  await assert.rejects(
    getSigningPayloadForToken(token, { database }),
    isExpired,
  );
  await assert.rejects(
    getSigningPayloadForToken(unopened, { database }),
    isExpired,
  );

  const fresh = await linkFor(admin, envelope.id, envelope.signers[0]!.id);

  assert.ok(await getSigningPayloadForToken(fresh, { database }));
});

test("a new deadline does not bring back or stretch an embedded link", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const signerId = envelope.signers[0]!.id;
  const token = await linkFor(admin, envelope.id, signerId);
  const before = await signerLink(signerId);

  await changeEnvelopeDeadline(
    admin.userId,
    envelope.id,
    { expiresInDays: 30, senderEmail: admin.email },
    { database },
  );
  assert.equal((await signerLink(signerId)).expiresAt, before.expiresAt);

  // An expired link stays expired.
  await database.query(
    `update signers set signing_token_expires_at = $2 where id = $1`,
    [signerId, Math.floor(Date.now() / 1000) - 1],
  );
  await changeEnvelopeDeadline(
    admin.userId,
    envelope.id,
    { expiresInDays: 30, senderEmail: admin.email },
    { database },
  );
  await assert.rejects(
    getSigningPayloadForToken(token, { database }),
    (error: unknown) =>
      error instanceof SigningAccessError && error.state === "expired",
  );
});

test("an old link opened while it is being replaced does not open the new one", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const signerId = envelope.signers[0]!.id;
  const oldToken = await linkFor(admin, envelope.id, signerId);
  let replaced = false;
  // Replaces the link between openEmbedLink's read and its update.
  const racing = {
    query: async (text: string, values?: unknown[]) => {
      const result = await database.query(text, values);

      if (!replaced) {
        replaced = true;
        await linkFor(admin, envelope.id, signerId);
      }

      return result;
    },
    connect: () => database.connect(),
  } as unknown as pg.Pool;

  await openEmbedLink(oldToken, ORIGIN, racing);
  assert.ok(replaced);

  const after = await signerLink(signerId);

  assert.equal(after.openedAt, null);
  assert.ok(after.expiresAt - Date.now() / 1000 <= 15 * 60 + 1);
});

test("a signer who declines in the app is recorded as declining there", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const signerId = envelope.signers[0]!.id;
  const token = await linkFor(admin, envelope.id, signerId);

  await openEmbedLink(token, ORIGIN, database);
  await declineSigningForToken(token, { reason: "Wrong terms" }, { database });

  const declined = await database.query<{ metadata: Record<string, unknown> }>(
    `
      select metadata from audit_events
      where envelope_id = $1 and event = 'declined'
    `,
    [envelope.id],
  );

  assert.deepEqual(declined.rows[0]?.metadata.embedded, {
    apiKeyName: "Portal",
    origin: ORIGIN,
  });
});

test("a finished embedded link opened again in its site says what happened, not that it expired", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const signerId = envelope.signers[0]!.id;
  const token = await linkFor(admin, envelope.id, signerId);
  const field = await database.query<{ id: string }>(
    `select id from fields where envelope_id = $1 and signer_id = $2`,
    [envelope.id, signerId],
  );

  await openEmbedLink(token, ORIGIN, database);
  await recordSignerConsent(
    token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );
  await submitSigningForToken(
    token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: field.rows[0]!.id,
          imageDataUrl: DRAWN_SIGNATURE,
          inputMethod: "drawn",
          type: "signature",
        },
      ],
    },
    { database },
  );

  const openedAt = (await signerLink(signerId)).openedAt;

  // The spent link passes the site checks, so the page goes on to say the
  // signer already signed...
  assert.deepEqual(await openEmbedLink(token, ORIGIN, database), {
    ok: true,
  });
  await assert.rejects(
    getSigningPayloadForToken(token, { database }),
    (error: unknown) =>
      error instanceof SigningAccessError && error.state === "already-signed",
  );
  // ...it opens nothing, and another site still learns nothing.
  assert.equal((await signerLink(signerId)).openedAt, openedAt);
  assert.deepEqual(
    await openEmbedLink(token, "https://other.example.com", database),
    { ok: false, reason: "wrong_origin" },
  );
});

test(
  "a signing already under way when its site is removed does not finish",
  needsPostgresLocks,
  async () => {
    const admin = await createAdmin();

    await addEmbedOrigin(admin, ORIGIN, { database });

    const envelope = await create(admin);
    const signerId = envelope.signers[0]!.id;
    const token = await linkFor(admin, envelope.id, signerId);
    const field = await database.query<{ id: string }>(
      `select id from fields where envelope_id = $1 and signer_id = $2`,
      [envelope.id, signerId],
    );

    await openEmbedLink(token, ORIGIN, database);
    await recordSignerConsent(
      token,
      { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
      { database },
    );

    // The removal holds the signer's row while the submission starts, and
    // expires the link (as removeEmbedOrigin does) once the submission waits.
    const remover = await database.connect();
    let submitted: Promise<unknown> | undefined;

    try {
      await remover.query("begin");
      await remover.query(`select id from signers where id = $1 for update`, [
        signerId,
      ]);
      submitted = submitSigningForToken(
        token,
        {
          clientTimezoneOffsetMinutes: 0,
          fields: [
            {
              fieldId: field.rows[0]!.id,
              imageDataUrl: DRAWN_SIGNATURE,
              inputMethod: "drawn",
              type: "signature",
            },
          ],
        },
        { database },
      );
      // Handled at once, so a failure before it waits is reported below
      // instead of as an unhandled rejection.
      submitted.catch(() => undefined);

      await waitUntilBlockedBy(database, remover);

      // The removal lands seconds after the submission is seen waiting, so
      // the link's new expiry is later than any time the submission read
      // before it began to wait. A check against such a time would still let
      // the link through.
      const waitingAt = Math.floor(Date.now() / 1000);
      while (Math.floor(Date.now() / 1000) < waitingAt + 2) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await remover.query(
        `update signers set signing_token_expires_at = $2 where id = $1`,
        [signerId, Math.floor(Date.now() / 1000) - 1],
      );
      await remover.query("commit");
    } finally {
      await remover.query("rollback").catch(() => undefined);
      await submitted?.catch(() => undefined);
      remover.release();
    }

    await assert.rejects(
      submitted!,
      (error: unknown) =>
        error instanceof SigningMutationError && error.statusCode === 409,
    );

    const signer = await database.query<{ status: string }>(
      `select status from signers where id = $1`,
      [signerId],
    );

    assert.equal(signer.rows[0]?.status, "notified");
  },
);

test("the evidence names the key that asked for the link, not the one that made the envelope", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const signerId = envelope.signers[0]!.id;
  const { summary: other } = await createApiKey(
    { email: admin.email, userId: admin.userId },
    { expiresInDays: null, name: "Kiosk", scope: "write" },
    database,
  );

  await linkFor(admin, envelope.id, signerId, other.id);
  assert.deepEqual(await readEmbedEvidence(envelope.id, signerId, database), {
    apiKeyName: "Kiosk",
    origin: ORIGIN,
  });
});

test("a link opened while its site is being removed stays expired", async () => {
  const admin = await createAdmin();

  await addEmbedOrigin(admin, ORIGIN, { database });

  const envelope = await create(admin);
  const signerId = envelope.signers[0]!.id;
  const token = await linkFor(admin, envelope.id, signerId);
  let removed = false;
  // Removes the site between openEmbedLink's read and its update.
  const racing = {
    query: async (text: string, values?: unknown[]) => {
      const result = await database.query(text, values);

      if (!removed) {
        removed = true;
        await removeEmbedOrigin(admin, ORIGIN, database);
      }

      return result;
    },
    connect: () => database.connect(),
  } as unknown as pg.Pool;

  assert.deepEqual(await openEmbedLink(token, ORIGIN, racing), {
    ok: false,
    reason: "wrong_origin",
  });
  assert.ok(removed);

  const after = await signerLink(signerId);

  assert.equal(after.openedAt, null);
  assert.ok(after.expiresAt < Date.now() / 1000);
});

test("a site already on a full list can be added again without an error", async () => {
  const admin = await createAdmin();
  const sites = Array.from(
    { length: 10 },
    (_, index) => `https://app${String(index)}.example.com`,
  );

  for (const site of sites) {
    await addEmbedOrigin(admin, site, { database });
  }

  assert.equal(await addEmbedOrigin(admin, sites[3]!, { database }), sites[3]!);
  await assert.rejects(
    addEmbedOrigin(admin, "https://eleventh.example.com", { database }),
    (error: unknown) =>
      error instanceof EmbeddingError && error.statusCode === 409,
  );
  assert.equal((await listEmbedOrigins(database)).length, 10);
});
