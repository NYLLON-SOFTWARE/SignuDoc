import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  createGoogleDriveClient,
  GoogleDriveClientError,
} from "./google-drive.ts";

const FOLDER = "drive-folder";
const PDF = {
  artifact: "signed" as const,
  bytes: Buffer.from("%PDF signed document"),
  envelopeId: "envelope-id",
  fileId: "reserved-id",
  name: "Example — signed.pdf",
};
const LOCATION =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=example";
const RECEIPT = {
  appProperties: {
    signudocEnvelope: PDF.envelopeId,
    signudocArtifact: PDF.artifact,
  },
  id: PDF.fileId,
  mimeType: "application/pdf",
  parents: [FOLDER],
  sha256Checksum: createHash("sha256").update(PDF.bytes).digest("hex"),
  size: String(PDF.bytes.length),
  trashed: false,
};

function fakeDrive(
  ...handlers: Array<(request: Request) => Response | Promise<Response>>
) {
  const remaining = [...handlers];
  const send: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const handler = remaining.shift();
    assert.ok(
      handler,
      `Unexpected request to ${new URL(request.url).pathname}`,
    );
    return handler(request);
  };
  const done = () => assert.equal(remaining.length, 0);
  return { send, done };
}

test("offline OAuth reserves file IDs and checks the folder capability using one token", async () => {
  const fake = fakeDrive(
    async (request) => {
      assert.equal(request.url, "https://oauth2.googleapis.com/token");
      assert.equal(request.method, "POST");
      const body = new URLSearchParams(await request.text());
      assert.deepEqual(Object.fromEntries(body), {
        client_id: "client",
        client_secret: "client-secret",
        grant_type: "refresh_token",
        refresh_token: "refresh-token",
      });
      return Response.json({ access_token: "bearer-token", expires_in: 3600 });
    },
    (request) => {
      const url = new URL(request.url);
      assert.equal(url.pathname, "/drive/v3/files/generateIds");
      assert.equal(url.searchParams.get("count"), "2");
      assert.equal(url.searchParams.get("space"), "drive");
      assert.equal(request.headers.get("authorization"), "Bearer bearer-token");
      return Response.json({ ids: ["signed-id", "certificate-id"] });
    },
    (request) => {
      const url = new URL(request.url);
      assert.equal(url.pathname, `/drive/v3/files/${FOLDER}`);
      assert.equal(url.searchParams.get("supportsAllDrives"), "true");
      assert.equal(request.headers.get("authorization"), "Bearer bearer-token");
      return Response.json({
        capabilities: { canAddChildren: true },
        id: FOLDER,
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
      });
    },
  );
  const drive = createGoogleDriveClient({
    clientId: "client",
    clientSecret: "client-secret",
    fetch: fake.send,
    folderId: FOLDER,
    refreshToken: "refresh-token",
  });
  assert.deepEqual(await drive.generateFileIds(2), [
    "signed-id",
    "certificate-id",
  ]);
  await drive.verifyFolder();
  fake.done();
});

const fixtureAccess = async () => "existing-token";

test("uploads original bytes with the reserved ID, folder and private ownership markers", async () => {
  const fake = fakeDrive(
    async (request) => {
      const url = new URL(request.url);
      assert.equal(request.method, "POST");
      assert.equal(url.pathname, "/upload/drive/v3/files");
      assert.equal(url.searchParams.get("supportsAllDrives"), "true");
      assert.equal(url.searchParams.get("uploadType"), "resumable");
      assert.equal(
        request.headers.get("x-upload-content-length"),
        RECEIPT.size,
      );
      assert.deepEqual(await request.json(), {
        appProperties: RECEIPT.appProperties,
        id: PDF.fileId,
        mimeType: "application/pdf",
        name: PDF.name,
        parents: [FOLDER],
      });
      return new Response(null, { headers: { location: LOCATION } });
    },
    async (request) => {
      assert.equal(request.url, LOCATION);
      assert.equal(request.redirect, "error");
      assert.equal(request.method, "PUT");
      assert.deepEqual(Buffer.from(await request.arrayBuffer()), PDF.bytes);
      return Response.json(RECEIPT, { status: 201 });
    },
  );
  await createGoogleDriveClient({
    fetch: fake.send,
    folderId: FOLDER,
    getAccessToken: fixtureAccess,
  }).uploadPdf(PDF);
  fake.done();
});

test("verifies a conflict without uploading a second copy", async () => {
  const fake = fakeDrive(
    () => new Response(null, { status: 409 }),
    (request) => {
      const url = new URL(request.url);
      assert.equal(url.pathname, `/drive/v3/files/${PDF.fileId}`);
      assert.equal(url.searchParams.get("supportsAllDrives"), "true");
      assert.equal(request.method, "GET");
      return Response.json(RECEIPT);
    },
  );
  await createGoogleDriveClient({
    fetch: fake.send,
    folderId: FOLDER,
    getAccessToken: fixtureAccess,
  }).uploadPdf(PDF);
  fake.done();
});

test("rejects a conflicting file when its identity, destination or contents differ", async () => {
  for (const metadata of [
    { id: "different-id" },
    { parents: ["another-folder"] },
    {
      appProperties: {
        ...RECEIPT.appProperties,
        signudocArtifact: "certificate",
      },
    },
    { sha256Checksum: "different-hash" },
    { trashed: true },
  ]) {
    const fake = fakeDrive(
      () => new Response(null, { headers: { location: LOCATION } }),
      () => new Response(null, { status: 409 }),
      () => Response.json({ ...RECEIPT, ...metadata }),
    );
    await assert.rejects(
      createGoogleDriveClient({
        fetch: fake.send,
        folderId: FOLDER,
        getAccessToken: fixtureAccess,
      }).uploadPdf(PDF),
      /could not verify the uploaded PDF/,
    );
    fake.done();
  }
});

test("rejects nonwritable folders and external upload session redirects", async () => {
  const fake = fakeDrive(
    () =>
      Response.json({
        capabilities: { canAddChildren: false },
        id: FOLDER,
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
      }),
    () =>
      new Response(null, {
        headers: {
          location: LOCATION.replace("www.googleapis.com", "another.example"),
        },
      }),
  );
  const drive = createGoogleDriveClient({
    fetch: fake.send,
    folderId: FOLDER,
    getAccessToken: fixtureAccess,
  });
  await assert.rejects(
    drive.verifyFolder(),
    /folder is unavailable for uploads/,
  );
  await assert.rejects(drive.uploadPdf(PDF), /invalid upload session/);
  fake.done();
});

test("reports Google errors by operation and HTTP status without provider content", async () => {
  const fake = fakeDrive(() =>
    Response.json({ error: "do not log this secret" }, { status: 403 }),
  );
  const drive = createGoogleDriveClient({
    fetch: fake.send,
    folderId: FOLDER,
    getAccessToken: fixtureAccess,
  });
  await assert.rejects(drive.generateFileIds(2), (error) => {
    assert.ok(error instanceof GoogleDriveClientError);
    assert.equal(error.status, 403);
    assert.match(error.message, /could not reserve file IDs/);
    assert.doesNotMatch(error.stack ?? "", /do not log this secret/);
    return true;
  });
  fake.done();
});
