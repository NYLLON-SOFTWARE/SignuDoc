import assert from "node:assert/strict";
import { test } from "node:test";

import { DocumentImportError } from "./document-import.ts";
import {
  discardPendingUpload,
  PendingUploadError,
  readPendingUpload,
} from "./pending-uploads.ts";
import {
  StorageObjectNotFoundError,
  type StorageService,
} from "./storage/types.ts";

const USER_ID = "user_abc123";
const KEY = `uploads/${USER_ID}/3f0e9a2c-5b7d-4e1f-8a6b-0c9d8e7f6a5b.pdf`;

function storageWith(
  overrides: Partial<StorageService>,
): StorageService & { deleted: string[] } {
  const deleted: string[] = [];

  return {
    deleted,
    async deleteObject(key) {
      deleted.push(key);
    },
    async getObject() {
      throw new Error("not used");
    },
    async getObjectStream(key) {
      throw new StorageObjectNotFoundError(key);
    },
    async headObject() {
      throw new Error("not used");
    },
    async putObject() {
      throw new Error("not used");
    },
    ...overrides,
  };
}

function streamOf(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });
}

test("a pending upload is read back in full", async () => {
  const storageService = storageWith({
    async getObjectStream(key) {
      return {
        bucketName: "test",
        contentLength: 5,
        key,
        stream: streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])),
      };
    },
  });

  assert.deepEqual(
    [
      ...(await readPendingUpload({
        key: KEY,
        storageService,
        userId: USER_ID,
      })),
    ],
    [1, 2, 3, 4, 5],
  );
});

test("only the user's own pending uploads can be read", async () => {
  let reads = 0;
  const storageService = storageWith({
    async getObjectStream(key) {
      reads += 1;

      return { bucketName: "test", key, stream: streamOf() };
    },
  });

  for (const key of [
    "uploads/someone_else/3f0e9a2c-5b7d-4e1f-8a6b-0c9d8e7f6a5b.pdf",
    `users/${USER_ID}/envelopes/e1/original.pdf`,
    `uploads/${USER_ID}/../x/3f0e9a2c-5b7d-4e1f-8a6b-0c9d8e7f6a5b.pdf`,
  ]) {
    await assert.rejects(
      readPendingUpload({ key, storageService, userId: USER_ID }),
      PendingUploadError,
    );
  }

  assert.equal(reads, 0);
});

test("an oversized upload is refused, whatever size the storage reports", async () => {
  const declaredTooLarge = storageWith({
    async getObjectStream(key) {
      return {
        bucketName: "test",
        contentLength: 11,
        key,
        stream: streamOf(new Uint8Array(11)),
      };
    },
  });
  const undeclared = storageWith({
    async getObjectStream(key) {
      return {
        bucketName: "test",
        // Claims to be small, then keeps sending.
        contentLength: 4,
        key,
        stream: streamOf(new Uint8Array(6), new Uint8Array(6)),
      };
    },
  });

  for (const storageService of [declaredTooLarge, undeclared]) {
    await assert.rejects(
      readPendingUpload({
        key: KEY,
        maxBytes: 10,
        storageService,
        userId: USER_ID,
      }),
      (error: unknown) =>
        error instanceof DocumentImportError && error.code === "too_large",
    );
  }
});

test("a pending upload that is gone asks the user to upload again", async () => {
  await assert.rejects(
    readPendingUpload({
      key: KEY,
      storageService: storageWith({}),
      userId: USER_ID,
    }),
    PendingUploadError,
  );
});

test("discarding deletes the upload and never throws", async () => {
  const storageService = storageWith({});

  await discardPendingUpload({ key: KEY, storageService });
  assert.deepEqual(storageService.deleted, [KEY]);

  const originalWarn = console.warn;

  console.warn = () => undefined;

  try {
    await discardPendingUpload({
      key: KEY,
      storageService: storageWith({
        async deleteObject() {
          throw new Error("storage is down");
        },
      }),
    });
  } finally {
    console.warn = originalWarn;
  }
});
