import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorizeDirectUpload,
  DirectUploadRequestError,
} from "./direct-upload.ts";
import { MAX_UPLOAD_SIZE_BYTES } from "../types/domain.ts";

const USER_ID = "user_abc123";
const UPLOAD_KEY = `uploads/${USER_ID}/3f0e9a2c-5b7d-4e1f-8a6b-0c9d8e7f6a5b.pdf`;

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

// Stands in for Blob's control API, which is not reachable from a test.
// The delegation token has the shape the SDK reads back when it signs a URL.
async function issueFakeToken(options: {
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  operations: string[];
  pathname: string;
  validUntil: number;
}) {
  return {
    clientSigningToken: "signing-secret",
    delegationToken: `${base64Url(
      JSON.stringify({ ...options, storeId: "store_test" }),
    )}.signature`,
    validUntil: options.validUntil,
  };
}

function authorize(body: unknown, userId = USER_ID) {
  return authorizeDirectUpload({
    body,
    issueToken: issueFakeToken,
    request: new Request("https://sign.example.com/api/uploads", {
      method: "POST",
    }),
    userId,
  });
}

function generateUrlEvent(pathname: string, multipart = false) {
  return {
    payload: { clientPayload: null, multipart, pathname },
    type: "blob.generate-presigned-url",
  };
}

test("a user gets a signed upload URL limited to one PDF in their own folder", async () => {
  const response = await authorize(generateUrlEvent(UPLOAD_KEY));

  assert.equal(response.type, "blob.generate-presigned-url");
  assert.ok("presignedUrlPayload" in response);
  assert.deepEqual(response.presignedUrlPayload.params, {
    "vercel-blob-add-random-suffix": "false",
    "vercel-blob-allow-overwrite": "false",
    "vercel-blob-allowed-content-types": "application/pdf",
    "vercel-blob-maximum-size-in-bytes": String(MAX_UPLOAD_SIZE_BYTES),
    "vercel-blob-ttl-days": "1",
  });
  assert.ok(response.presignedUrlPayload.signature.length > 0);

  const delegation = JSON.parse(
    Buffer.from(
      response.presignedUrlPayload.delegationToken.split(".")[0]!,
      "base64url",
    ).toString(),
  );

  assert.equal(delegation.pathname, UPLOAD_KEY);
  assert.deepEqual(delegation.operations, ["put"]);
  assert.deepEqual(delegation.allowedContentTypes, ["application/pdf"]);
  assert.equal(delegation.maximumSizeInBytes, MAX_UPLOAD_SIZE_BYTES);
  assert.ok(delegation.validUntil > Date.now());
  assert.ok(delegation.validUntil <= Date.now() + 10 * 60 * 1000);
});

test("upload destinations outside the user's own pending folder are refused", async () => {
  for (const pathname of [
    "uploads/someone_else/3f0e9a2c-5b7d-4e1f-8a6b-0c9d8e7f6a5b.pdf",
    `uploads/${USER_ID}/../someone_else/3f0e9a2c-5b7d-4e1f-8a6b-0c9d8e7f6a5b.pdf`,
    `uploads/${USER_ID}/contract.pdf`,
    `uploads/${USER_ID}/3f0e9a2c-5b7d-4e1f-8a6b-0c9d8e7f6a5b.exe`,
    `uploads/${USER_ID}/nested/3f0e9a2c-5b7d-4e1f-8a6b-0c9d8e7f6a5b.pdf`,
    `users/${USER_ID}/envelopes/3f0e9a2c-5b7d-4e1f-8a6b-0c9d8e7f6a5b/original.pdf`,
    "",
  ]) {
    await assert.rejects(
      authorize(generateUrlEvent(pathname)),
      DirectUploadRequestError,
      pathname,
    );
  }
});

test("multipart uploads and other event types are refused", async () => {
  await assert.rejects(
    authorize(generateUrlEvent(UPLOAD_KEY, true)),
    DirectUploadRequestError,
  );

  for (const body of [
    null,
    "text",
    {},
    { type: "blob.upload-completed", payload: { blob: {}, tokenPayload: "" } },
    { type: "blob.generate-client-token", payload: { pathname: UPLOAD_KEY } },
    { type: "blob.generate-presigned-url" },
    { type: "blob.generate-presigned-url", payload: { pathname: 42 } },
  ]) {
    await assert.rejects(authorize(body), DirectUploadRequestError);
  }
});
