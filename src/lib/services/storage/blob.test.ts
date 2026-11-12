import assert from "node:assert/strict";
import { test } from "node:test";

import { BlobNotFoundError } from "@vercel/blob";

import { ServiceConfigurationError } from "../service-config.ts";
import { type BlobClient, createBlobStorageService } from "./blob.ts";
import { resolveStorageDriver, supportsDirectUploads } from "./driver.ts";
import { StorageObjectNotFoundError } from "./types.ts";

type StoredBlob = { body: Uint8Array; contentType: string };

// An in-memory stand-in for the Blob SDK that records how it was called.
function createFakeBlobClient() {
  const blobs = new Map<string, StoredBlob>();
  const calls: Array<{ args: unknown[]; method: string }> = [];
  const client = {
    async del(pathname: string) {
      calls.push({ args: [pathname], method: "del" });
      blobs.delete(pathname);
    },
    async get(pathname: string, options: unknown) {
      calls.push({ args: [pathname, options], method: "get" });

      const blob = blobs.get(pathname);

      if (!blob) {
        return null;
      }

      return {
        blob: {
          contentType: blob.contentType,
          etag: '"etag"',
          pathname,
          size: blob.body.byteLength,
        },
        headers: new Headers(),
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(blob.body);
            controller.close();
          },
        }),
      };
    },
    async head(pathname: string) {
      calls.push({ args: [pathname], method: "head" });

      const blob = blobs.get(pathname);

      if (!blob) {
        throw new BlobNotFoundError();
      }

      return {
        contentType: blob.contentType,
        etag: '"etag"',
        pathname,
        size: blob.body.byteLength,
      };
    },
    async put(
      pathname: string,
      body: Buffer,
      options: { contentType: string },
    ) {
      calls.push({ args: [pathname, body, options], method: "put" });
      blobs.set(pathname, {
        body: new Uint8Array(body),
        contentType: options.contentType,
      });

      return { pathname };
    },
  };

  return { blobs, calls, client: client as unknown as BlobClient };
}

const connectedEnv = { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store_secret" };
const KEY = "users/u1/envelopes/e1/original.pdf";

test("objects are written privately, without a random suffix, and replace what was there", async () => {
  const { calls, client } = createFakeBlobClient();
  const storage = createBlobStorageService({ client, env: connectedEnv });
  // A view into a larger buffer: only the viewed bytes may be stored.
  const body = new Uint8Array([9, 9, 1, 2, 3, 9]).subarray(2, 5);

  const reference = await storage.putObject({
    body,
    contentType: "application/pdf",
    key: `/${KEY}`,
  });

  assert.equal(reference.key, KEY);

  const [put] = calls;

  assert.equal(put?.method, "put");
  assert.equal(put?.args[0], KEY);
  assert.deepEqual([...(put?.args[1] as Buffer)], [1, 2, 3]);
  assert.deepEqual(put?.args[2], {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/pdf",
  });
});

test("objects are read back whole or as a stream, bypassing the cache", async () => {
  const { calls, client } = createFakeBlobClient();
  const storage = createBlobStorageService({ client, env: connectedEnv });

  await storage.putObject({
    body: new Uint8Array([1, 2, 3, 4]),
    contentType: "application/pdf",
    key: KEY,
  });

  const object = await storage.getObject(KEY);

  assert.deepEqual([...object.body], [1, 2, 3, 4]);
  assert.equal(object.contentLength, 4);
  assert.equal(object.contentType, "application/pdf");

  const streamed = await storage.getObjectStream(KEY);

  assert.equal(streamed.contentLength, 4);
  assert.equal(streamed.contentType, "application/pdf");
  assert.deepEqual(
    [...new Uint8Array(await new Response(streamed.stream).arrayBuffer())],
    [1, 2, 3, 4],
  );

  for (const call of calls.filter(({ method }) => method === "get")) {
    assert.deepEqual(call.args[1], { access: "private", useCache: false });
  }
});

test("a missing object is reported the way the rest of the app expects", async () => {
  const { client } = createFakeBlobClient();
  const storage = createBlobStorageService({ client, env: connectedEnv });

  await assert.rejects(storage.getObject(KEY), StorageObjectNotFoundError);
  await assert.rejects(
    storage.getObjectStream(KEY),
    StorageObjectNotFoundError,
  );
  assert.deepEqual(await storage.headObject(KEY), {
    bucketName: "vercel-blob",
    exists: false,
    key: KEY,
  });
});

test("head and delete work on stored objects", async () => {
  const { blobs, client } = createFakeBlobClient();
  const storage = createBlobStorageService({ client, env: connectedEnv });

  await storage.putObject({
    body: new Uint8Array(7),
    contentType: "image/png",
    key: KEY,
  });

  const head = await storage.headObject(KEY);

  assert.equal(head.exists, true);
  assert.equal(head.contentLength, 7);
  assert.equal(head.contentType, "image/png");

  await storage.deleteObject(KEY);

  assert.equal(blobs.size, 0);
});

test("keys that could escape their folder are refused", async () => {
  const { client } = createFakeBlobClient();
  const storage = createBlobStorageService({ client, env: connectedEnv });

  await assert.rejects(storage.getObject("users/../secrets.pdf"));
  await assert.rejects(storage.deleteObject(""));
});

test("without a connected Blob store the driver says what is missing", () => {
  assert.throws(
    () => createBlobStorageService({ env: {} }),
    ServiceConfigurationError,
  );
});

test("the storage driver is chosen from what is connected", () => {
  assert.equal(resolveStorageDriver({}), "local");
  assert.equal(resolveStorageDriver(connectedEnv), "blob");
  assert.equal(resolveStorageDriver({ BLOB_STORE_ID: "store_abc" }), "blob");
  // On Vercel there is no disk, so Blob is the only option even before a
  // store is connected. Creating the service then names what is missing.
  assert.equal(resolveStorageDriver({ VERCEL: "1" }), "blob");
  assert.equal(
    resolveStorageDriver({ ...connectedEnv, STORAGE_DRIVER: "local" }),
    "local",
  );
  assert.equal(resolveStorageDriver({ STORAGE_DRIVER: " Blob " }), "blob");
  assert.throws(() => resolveStorageDriver({ STORAGE_DRIVER: "r2" }), /r2/);

  assert.equal(supportsDirectUploads(connectedEnv), true);
  assert.equal(supportsDirectUploads({}), false);
});
