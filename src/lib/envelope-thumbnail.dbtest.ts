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
import { deleteEnvelopesAndFiles } from "./retention.ts";
import { buildEnvelopeThumbnailKey } from "./services/storage-keys.ts";
import { buildThumbnailEtag } from "./services/thumbnails.ts";
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

// The same, but 480 x 512: a different picture that is just as valid.
const OTHER_THUMBNAIL = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x01, 0xe0, 0x03, 0x01,
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

// Where insertDraft says the original is: under the user who created it.
function thumbnailKey(input: { envelopeId: string; userId: string }): string {
  return buildEnvelopeThumbnailKey({
    ...input,
    sourcePdfKey: `users/${input.userId}/envelopes/${input.envelopeId}/original.pdf`,
  });
}

async function thumbnailExists(input: {
  envelopeId: string;
  userId: string;
}): Promise<boolean> {
  const head = await storageService.headObject(thumbnailKey(input));

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

test("a browser that already holds the picture is answered without a read from file storage", async () => {
  const draft = await insertDraft();

  await saveEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    THUMBNAIL,
    { database, storageService },
  );

  const first = await getEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    { database, storageService },
  );

  assert.equal(first.isNotModified, false);

  if (!first.isNotModified) {
    await first.picture.stream.cancel();
  }

  // From here on, any read of a file fails the test.
  const noReads: StorageService = {
    ...storageService,
    getObject: () => assert.fail("read a file"),
    getObjectStream: () => assert.fail("read a file"),
    headObject: () => assert.fail("read a file"),
  };
  const again = await getEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    { database, ifNoneMatch: first.etag, storageService: noReads },
  );

  assert.deepEqual(again, { etag: first.etag, isNotModified: true });

  // The name of another envelope's picture is not this one's.
  const other = await insertDraft();
  const otherEtag = buildThumbnailEtag(other.envelopeId);

  assert.notEqual(otherEtag, first.etag);

  const mismatched = await getEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    { database, ifNoneMatch: otherEtag, storageService },
  );

  assert.equal(mismatched.isNotModified, false);

  if (!mismatched.isNotModified) {
    await mismatched.picture.stream.cancel();
  }
});

test("an envelope keeps the first picture it is given", async () => {
  const draft = await insertDraft();

  await saveEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    THUMBNAIL,
    { database, storageService },
  );
  // Accepted, and not kept: a browser that holds the first picture is told
  // it is still good, so it has to stay the one that is stored.
  await saveEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    OTHER_THUMBNAIL,
    { database, storageService },
  );

  const stored = await storageService.getObject(thumbnailKey(draft));

  assert.deepEqual(Array.from(stored.body), Array.from(THUMBNAIL));
});

test("quoting a picture's name does not show it to another account", async () => {
  const draft = await insertDraft();
  const stranger = await insertDraft();

  await saveEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    THUMBNAIL,
    { database, storageService },
  );

  // The account is checked before the name is: someone who knows the
  // envelope's id, and so its picture's name, learns nothing from asking.
  await assert.rejects(
    getEnvelopeThumbnailForUser(stranger.userId, draft.envelopeId, {
      database,
      ifNoneMatch: buildThumbnailEtag(draft.envelopeId),
      storageService,
    }),
    assertNotFound,
  );
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

test("a picture stays with an envelope that is handed to another account", async () => {
  const draft = await insertDraft();
  const keeper = await insertDraft();

  await saveEnvelopeThumbnailForUser(
    draft.userId,
    draft.envelopeId,
    THUMBNAIL,
    { database, storageService },
  );

  // What closing an account does to its finished envelopes: the row moves,
  // the files stay where they were stored.
  await database.query(
    "update public.envelopes set status = 'completed', user_id = $1 where id = $2",
    [keeper.userId, draft.envelopeId],
  );

  const thumbnail = await getEnvelopeThumbnailForUser(
    keeper.userId,
    draft.envelopeId,
    { database, storageService },
  );

  assert.equal(thumbnail.isNotModified, false);

  if (!thumbnail.isNotModified) {
    await thumbnail.picture.stream.cancel();
  }
  await assert.rejects(
    getEnvelopeThumbnailForUser(draft.userId, draft.envelopeId, {
      database,
      storageService,
    }),
    assertNotFound,
  );

  // Deleting it later removes the picture from where it really is, and
  // leaves nothing under the new owner either.
  assert.equal(
    await deleteEnvelopesAndFiles([draft.envelopeId], database, storageService),
    1,
  );
  assert.equal(await thumbnailExists(draft), false);
  assert.equal(
    await thumbnailExists({
      envelopeId: draft.envelopeId,
      userId: keeper.userId,
    }),
    false,
  );
});

test("a picture stored while a finished envelope is being deleted does not stay behind", async () => {
  const draft = await insertDraft();

  await database.query(
    "update public.envelopes set status = 'completed' where id = $1",
    [draft.envelopeId],
  );

  // Finished envelopes lose their files first and their row after. The
  // upload lands between the two: it finds the row and keeps its picture.
  let stored = false;
  const storageWithLateUpload: StorageService = {
    ...storageService,
    async deleteObject(key) {
      await storageService.deleteObject(key);

      if (!stored && key === thumbnailKey(draft)) {
        stored = true;
        await saveEnvelopeThumbnailForUser(
          draft.userId,
          draft.envelopeId,
          THUMBNAIL,
          { database, storageService },
        );
      }
    },
    getObject: (key) => storageService.getObject(key),
    getObjectStream: (key) => storageService.getObjectStream(key),
    headObject: (key) => storageService.headObject(key),
    putObject: (input) => storageService.putObject(input),
  };

  assert.equal(
    await deleteEnvelopesAndFiles(
      [draft.envelopeId],
      database,
      storageWithLateUpload,
    ),
    1,
  );

  assert.equal(stored, true);
  assert.equal(await thumbnailExists(draft), false);
});
