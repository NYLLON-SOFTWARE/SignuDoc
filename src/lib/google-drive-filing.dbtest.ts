import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { runGoogleDriveFiling } from "./google-drive-filing.ts";
import type { GoogleDriveClient } from "./services/google-drive.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";

const startAt = "2026-10-01T00:00:00Z";
const startSeconds = Date.parse(startAt) / 1000;
const pdf = Buffer.from("%PDF-1.7\nA signing fixture\n%%EOF");
const sha256 = createHash("sha256").update(pdf).digest("hex");
const users: string[] = [];
let database: pg.Pool;
let storageService: StorageService;
let directory: string;

before(async () => {
  database = await openTestDatabase();
  directory = await mkdtemp(join(tmpdir(), "signudoc-drive-filing-"));
  storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: directory },
  });
});

after(async () => {
  await database?.query(`DELETE FROM "user" WHERE id = ANY($1)`, [users]);
  await database?.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function makeOwner(verified = true) {
  const id = randomUUID();
  const email = id + "@example.test";
  users.push(id);
  await database.query(
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Alex Sender', $2, $3)`,
    [id, email, verified],
  );
  return { id, email };
}

async function makeEnvelope(
  ownerId: string,
  { when = startSeconds, status = "completed", hash = sha256 } = {},
) {
  const id = randomUUID();
  const signed = `test/${id}/signed.pdf`;
  const certificate = `test/${id}/certificate.pdf`;
  await database.query(
    `INSERT INTO envelopes (id, user_id, title, status, source_pdf_key,
    source_pdf_filename, source_pdf_size_bytes, source_pdf_hash, page_count, completed_at,
    signed_pdf_key, evidence_key, signed_pdf_sha256, evidence_sha256)
    VALUES ($1, $2, 'Confidential / test', $3, $1 || '/original.pdf', 'original.pdf', $4, $5, 1, $6, $7, $8, $9, $5)`,
    [id, ownerId, status, pdf.length, sha256, when, signed, certificate, hash],
  );
  for (const key of [signed, certificate]) {
    await storageService.putObject({
      body: pdf,
      contentType: "application/pdf",
      key,
    });
  }
  return id;
}

function driveEnv(email: string) {
  return {
    SIGNUDOC_DRIVE_FOLDER_ID: "test-drive-folder",
    SIGNUDOC_DRIVE_OWNER_EMAIL: email,
    SIGNUDOC_DRIVE_START_AT: startAt,
    SIGNUDOC_DRIVE_CLIENT_ID: "mock-client",
    SIGNUDOC_DRIVE_CLIENT_SECRET: "mock-client-secret",
    SIGNUDOC_DRIVE_REFRESH_TOKEN: "mock-refresh-token",
  };
}

function driveClient(
  uploadPdf: GoogleDriveClient["uploadPdf"],
): GoogleDriveClient {
  return {
    generateFileIds: async () => [randomUUID(), randomUUID()],
    uploadPdf,
    verifyFolder: async () => {},
  };
}

test("only the configured verified sender's post-start completed envelopes file", async () => {
  const owner = await makeOwner();
  const other = await makeOwner();
  const unverified = await makeOwner(false);
  const closed = await makeOwner();
  const envelopeId = await makeEnvelope(owner.id);
  await makeEnvelope(owner.id, { when: startSeconds - 1 });
  await makeEnvelope(owner.id, { status: "sent" });
  await makeEnvelope(other.id);
  await makeEnvelope(unverified.id);
  await makeEnvelope(closed.id);
  await database.query(
    `INSERT INTO account_closure_requests
    (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
    VALUES ($1, $2, $2, $2, $2)`,
    [closed.id, startSeconds],
  );
  const uploads: Parameters<GoogleDriveClient["uploadPdf"]>[0][] = [];
  const client = driveClient(async (upload) => {
    uploads.push(upload);
  });
  const options = { database, storageService, clientFactory: () => client };
  const first = await runGoogleDriveFiling({
    ...options,
    env: driveEnv(owner.email.toUpperCase()),
  });
  assert.deepEqual(first, { filed: 1, failures: 0, stoppedEarly: false });
  assert.deepEqual(
    uploads.map(({ envelopeId: id, artifact, name }) => [id, artifact, name]),
    [
      [envelopeId, "signed", "Confidential test - signed.pdf"],
      [envelopeId, "certificate", "Confidential test - certificate.pdf"],
    ],
  );
  assert.ok(uploads.every(({ bytes }) => pdf.equals(bytes)));
  assert.deepEqual(
    await runGoogleDriveFiling({ ...options, env: driveEnv(owner.email) }),
    { filed: 0, failures: 0, stoppedEarly: false },
  );
  assert.deepEqual(
    await runGoogleDriveFiling({ ...options, env: driveEnv(unverified.email) }),
    { filed: 0, failures: 0, stoppedEarly: false },
  );
  assert.deepEqual(
    await runGoogleDriveFiling({ ...options, env: driveEnv(closed.email) }),
    { filed: 0, failures: 0, stoppedEarly: false },
  );
  assert.equal(uploads.length, 2);
});

test("a completion attempt files only that envelope even when older work is pending", async () => {
  const owner = await makeOwner();
  const pending = await makeEnvelope(owner.id);
  const completed = await makeEnvelope(owner.id, { when: startSeconds + 1 });
  const unfinished = await makeEnvelope(owner.id, { status: "sent" });
  const other = await makeEnvelope((await makeOwner()).id);
  const uploaded: string[] = [];
  const options = {
    database,
    storageService,
    env: driveEnv(owner.email),
    clientFactory: () =>
      driveClient(async ({ envelopeId }) => {
        uploaded.push(envelopeId);
      }),
  };

  for (const envelopeId of [unfinished, other, completed, completed]) {
    await runGoogleDriveFiling({ ...options, envelopeId });
  }
  assert.deepEqual(uploaded, [completed, completed]);
  await runGoogleDriveFiling(options);
  assert.deepEqual(uploaded, [completed, completed, pending, pending]);
});

test("the daily job retries an unfinished immediate upload with its reserved Drive ID", async () => {
  const owner = await makeOwner();
  const id = await makeEnvelope(owner.id);
  const uploads: string[][] = [];
  let failed = false;
  const client = driveClient(async ({ artifact, envelopeId, fileId }) => {
    assert.equal(envelopeId, id);
    uploads.push([artifact, fileId]);
    if (artifact === "certificate" && !failed) {
      failed = true;
      throw new Error("simulated lost response");
    }
  });
  const options = {
    database,
    storageService,
    env: driveEnv(owner.email),
    clientFactory: () => client,
  };
  assert.equal(
    (await runGoogleDriveFiling({ ...options, envelopeId: id }))?.failures,
    1,
  );
  const changedFolder = {
    ...options,
    env: { ...options.env, SIGNUDOC_DRIVE_FOLDER_ID: "different-test-folder" },
  };
  assert.equal((await runGoogleDriveFiling(changedFolder))?.failures, 1);
  assert.equal(uploads.length, 2);
  assert.equal((await runGoogleDriveFiling(options))?.filed, 1);
  assert.deepEqual(
    uploads.map(([artifact]) => artifact),
    ["signed", "certificate", "certificate"],
  );
  assert.equal(uploads[1]?.[1], uploads[2]?.[1]);
});

test("overlapping completion and daily attempts upload each artifact once", async () => {
  const owner = await makeOwner();
  const envelopeId = await makeEnvelope(owner.id);
  const uploads: string[] = [];
  const bothStarted = Promise.withResolvers<void>();
  let attempts = 0;
  const client = driveClient(async ({ artifact }) => {
    uploads.push(artifact);
  });
  client.verifyFolder = async () => {
    attempts += 1;
    if (attempts === 2) bothStarted.resolve();
    await bothStarted.promise;
  };
  const options = {
    database,
    storageService,
    env: driveEnv(owner.email),
    clientFactory: () => client,
  };
  const results = await Promise.all([
    runGoogleDriveFiling({ ...options, envelopeId }),
    runGoogleDriveFiling(options),
  ]);
  assert.deepEqual(
    results.map((result) => result?.failures),
    [0, 0],
  );
  assert.deepEqual(uploads, ["signed", "certificate"]);
});

test("missing config disables filing and an unverified artifact never uploads", async () => {
  const owner = await makeOwner();
  await makeEnvelope(owner.id, { hash: "b".repeat(64) });
  let uploads = 0;
  const client = driveClient(async () => {
    uploads++;
  });
  const options = { database, storageService, clientFactory: () => client };
  assert.equal(await runGoogleDriveFiling({ ...options, env: {} }), undefined);
  await assert.rejects(
    runGoogleDriveFiling({
      ...options,
      env: {
        ...driveEnv(owner.email),
        SIGNUDOC_DRIVE_START_AT: "2026-02-30T00:00:00Z",
      },
    }),
    /UTC start time/,
  );
  assert.equal(
    (await runGoogleDriveFiling({ ...options, env: driveEnv(owner.email) }))
      ?.failures,
    1,
  );
  assert.equal(uploads, 0);
});

test(
  "the filing deadline cancels a stalled storage read before upload",
  { timeout: 5000 },
  async () => {
    const owner = await makeOwner();
    await makeEnvelope(owner.id);
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<void>();
    let canceled = false;
    let uploads = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          started.resolve();
          return stalled.promise;
        },
        cancel() {
          canceled = true;
          stalled.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    const run = runGoogleDriveFiling({
      database,
      env: driveEnv(owner.email),
      storageService: {
        ...storageService,
        async getObjectStream(key) {
          return { key, bucketName: "test", stream };
        },
      },
      clientFactory: () =>
        driveClient(async () => {
          uploads++;
        }),
      signal: abort.signal,
    });

    await started.promise;
    abort.abort();

    assert.deepEqual(await run, { filed: 0, failures: 1, stoppedEarly: true });
    assert.equal(canceled, true);
    assert.equal(uploads, 0);
  },
);

test("Drive filing honors an account closure requested while storage is being read", async () => {
  const owner = await makeOwner();
  await makeEnvelope(owner.id);
  let closureRecorded = false;
  let uploads = 0;
  const result = await runGoogleDriveFiling({
    database,
    env: driveEnv(owner.email),
    storageService: {
      ...storageService,
      async getObjectStream(key) {
        const connection = await database.connect();
        try {
          await connection.query("BEGIN");
          await connection.query("SET LOCAL lock_timeout = '1s'");
          await connection.query(
            `INSERT INTO account_closure_requests
             (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
             VALUES ($1, $2, $2, $2, $2)`,
            [owner.id, startSeconds],
          );
          await connection.query("COMMIT");
          closureRecorded = true;
        } finally {
          await connection.query("ROLLBACK");
          connection.release();
        }
        return storageService.getObjectStream(key);
      },
    },
    clientFactory: () =>
      driveClient(async () => {
        uploads++;
      }),
  });

  assert.deepEqual(result, { filed: 0, failures: 1, stoppedEarly: false });
  assert.equal(closureRecorded, true);
  assert.equal(uploads, 0);
});
