import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  deleteDraftEnvelope,
  EnvelopeDocumentAccessError,
  getEnvelopeThumbnailForUser,
  saveEnvelopeThumbnailForUser,
} from "./envelopes.ts";
import { buildEnvelopeThumbnailKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";

// The first-page picture and the envelope it belongs to, against a real
// Postgres: a picture must never outlive its envelope, even when the two
// are written and deleted at the same moment. Run with `npm run test:db`.

// Just the headers of a 480 x 621 JPEG, which is all the size check reads.
const THUMBNAIL = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x6d, 0x01, 0xe0, 0x03, 0x01,
  0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const userIds: string[] = [];

async function insertDraft(): Promise<{ envelopeId: string; userId: string }> {
  const userId = randomUUID();
  const envelopeId = randomUUID();

  await database.query(
    `insert into public."user" (id, name, email) values ($1, $2, $3)`,
    [userId, "Thumbnail Tester", `thumbnail+${userId}@example.com`],
  );
  await database.query(
    `
      insert into public.envelopes (
        id, user_id, title, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      envelopeId,
      userId,
      "Thumbnail test",
      `users/${userId}/envelopes/${envelopeId}/original.pdf`,
      "sample.pdf",
      1024,
      1,
      "0".repeat(64),
    ],
  );
  userIds.push(userId);

  return { envelopeId, userId };
}

async function thumbnailExists(input: {
  envelopeId: string;
  userId: string;
}): Promise<boolean> {
  const head = await storageService.headObject(
    buildEnvelopeThumbnailKey(input),
  );

  return head.exists;
}

function assertNotFound(error: unknown): true {
  assert.ok(error instanceof EnvelopeDocumentAccessError);
  assert.equal(error.statusCode, 404);

  return true;
}

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-thumbnail-"));
  storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    userIds,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

test("a picture is kept for an envelope that exists", async () => {
  const draft = await insertDraft();

  await saveEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    THUMBNAIL,
    { database, storageService },
  );

  assert.equal(await thumbnailExists(draft), true);
});

test("nobody else can store a picture for the envelope", async () => {
  const draft = await insertDraft();
  const stranger = await insertDraft();

  await assert.rejects(
    saveEnvelopeThumbnailForUser(stranger.userId, draft.envelopeId, THUMBNAIL, {
      database,
      storageService,
    }),
    assertNotFound,
  );

  assert.equal(await thumbnailExists(draft), false);
  assert.equal(
    await thumbnailExists({
      envelopeId: draft.envelopeId,
      userId: stranger.userId,
    }),
    false,
  );
});

test("a picture written while its draft is being deleted does not stay behind", async () => {
  const draft = await insertDraft();
  // The upload passes its first check, and the draft is deleted, files and
  // all, before the picture reaches storage.
  const storageWithSlowWrite: StorageService = {
    ...storageService,
    deleteObject: (key) => storageService.deleteObject(key),
    getObject: (key) => storageService.getObject(key),
    getObjectStream: (key) => storageService.getObjectStream(key),
    headObject: (key) => storageService.headObject(key),
    async putObject(input) {
      await database.query("delete from public.envelopes where id = $1", [
        draft.envelopeId,
      ]);
      await storageService.deleteObject(input.key);

      return storageService.putObject(input);
    },
  };

  await assert.rejects(
    saveEnvelopeThumbnailForUser(draft.userId, draft.envelopeId, THUMBNAIL, {
      database,
      storageService: storageWithSlowWrite,
    }),
    assertNotFound,
  );

  assert.equal(await thumbnailExists(draft), false);
});

test("deleting a draft removes its picture", async () => {
  const draft = await insertDraft();

  await saveEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    THUMBNAIL,
    { database, storageService },
  );
  assert.equal(await thumbnailExists(draft), true);

  await deleteDraftEnvelope(draft.userId, draft.envelopeId, {
    database,
    storageService,
  });

  assert.equal(await thumbnailExists(draft), false);
  await assert.rejects(
    getEnvelopeThumbnailForUser(draft.userId, draft.envelopeId, {
      database,
      storageService,
    }),
    assertNotFound,
  );
});
