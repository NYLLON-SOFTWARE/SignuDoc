import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  createStorageService,
  StorageObjectNotFoundError,
} from "../storage.ts";

const skip = process.env.S3_INTEGRATION_TEST !== "1";

test(
  "S3-compatible storage round-trips metadata, bytes, and deletes",
  { skip },
  async (t) => {
    const storage = createStorageService({
      env: { ...process.env, STORAGE_DRIVER: "s3" },
    });
    const key = `signudoc-test/${randomUUID()}/roundtrip.pdf`;
    t.after(() => storage.deleteObject(key));
    const body = Uint8Array.of(0, 1, 127, 255);

    assert.equal((await storage.headObject(key)).exists, false);
    await assert.rejects(storage.getObject(key), StorageObjectNotFoundError);
    assert.deepEqual(
      await storage.putObject({ key, body, contentType: "application/pdf" }),
      { bucketName: process.env.S3_BUCKET?.trim(), key },
    );

    const head = await storage.headObject(key);
    assert.equal(head.exists, true);
    assert.equal(head.contentType, "application/pdf");
    assert.equal(head.contentLength, 4);
    assert.ok(head.etag);
    const object = await storage.getObject(key);
    assert.deepEqual(object.body, body);
    assert.equal(object.etag, head.etag);
    const streamed = await storage.getObjectStream(key);
    assert.equal(streamed.contentType, "application/pdf");
    assert.equal(streamed.contentLength, 4);
    assert.deepEqual(
      new Uint8Array(await new Response(streamed.stream).arrayBuffer()),
      body,
    );
    await storage.deleteObject(key);
    await storage.deleteObject(key);
    assert.equal((await storage.headObject(key)).exists, false);
  },
);

test(
  "S3-compatible storage retains a single winner under concurrent conditional writes",
  { skip },
  async (t) => {
    const storage = createStorageService({
      env: { ...process.env, STORAGE_DRIVER: "s3" },
    });
    const key = `signudoc-test/${randomUUID()}/race.pdf`;
    t.after(() => storage.deleteObject(key));

    const writes = await Promise.allSettled(
      [1, 2, 3, 4].map((byte) =>
        storage.putObject({
          key,
          body: Uint8Array.of(byte),
          contentType: "application/pdf",
          keepExisting: true,
        }),
      ),
    );
    for (const write of writes) {
      if (write.status === "rejected") throw write.reason;
    }

    const winner = await storage.getObject(key);
    assert.equal(winner.body.byteLength, 1);
    assert.ok([1, 2, 3, 4].includes(winner.body[0]));

    await storage.putObject({
      key,
      body: Uint8Array.of(5),
      contentType: "image/png",
      keepExisting: true,
    });
    const retained = await storage.getObject(key);
    assert.deepEqual(retained.body, winner.body);
    assert.equal(retained.contentType, "application/pdf");
    assert.equal(retained.etag, winner.etag);

    await storage.putObject({
      key,
      body: Uint8Array.of(6),
      contentType: "application/pdf",
    });
    assert.deepEqual((await storage.getObject(key)).body, Uint8Array.of(6));
  },
);
