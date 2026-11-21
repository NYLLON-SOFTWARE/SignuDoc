import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveStorageDriver, supportsDirectUploads } from "./driver.ts";

test("S3 settings alone preserve implicit Local and Blob selection", () => {
  const s3 = { S3_BUCKET: "documents", S3_REGION: "us-east-1" };
  assert.equal(resolveStorageDriver(s3), "local");
  assert.equal(resolveStorageDriver({ ...s3, VERCEL: "1" }), "blob");
  assert.equal(
    resolveStorageDriver({ ...s3, BLOB_STORE_ID: "store_example" }),
    "blob",
  );
});

test("explicit S3 takes precedence over Blob and uses app uploads", () => {
  const env = {
    STORAGE_DRIVER: " S3 ",
    BLOB_READ_WRITE_TOKEN: "test-blob-token",
    VERCEL: "1",
  };
  assert.equal(resolveStorageDriver(env), "s3");
  assert.equal(supportsDirectUploads(env), false);
});
