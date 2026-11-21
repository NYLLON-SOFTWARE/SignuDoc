import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ATTEMPTS, nextAttemptAt } from "./deliver.ts";
import { parseWebhookEventTypes, webhookEventForAuditEvent } from "./events.ts";
import {
  parseWebhookUrl,
  postWebhook,
  privateWebhookUrlsAllowed,
} from "./safe-post.ts";

test("retries back off and stop after the last try", () => {
  assert.equal(MAX_ATTEMPTS, 8);
  assert.equal(nextAttemptAt(1, 0), 60);
  assert.equal(nextAttemptAt(2, 0), 300);
  assert.equal(nextAttemptAt(5, 0), 8 * 60 * 60);
  assert.equal(nextAttemptAt(7, 0), 24 * 60 * 60);
  assert.equal(nextAttemptAt(8, 0), null);
});

test("audit events map to webhook events, and others to none", () => {
  assert.equal(webhookEventForAuditEvent("sent"), "envelope.sent");
  assert.equal(webhookEventForAuditEvent("viewed"), "signer.viewed");
  assert.equal(webhookEventForAuditEvent("completed"), "envelope.completed");
  // An approver's approval and rejection.
  assert.equal(webhookEventForAuditEvent("approved"), "signer.signed");
  assert.equal(webhookEventForAuditEvent("rejected"), "envelope.declined");
  assert.equal(webhookEventForAuditEvent("email_sent"), null);
  assert.equal(webhookEventForAuditEvent("consented"), null);
});

test("event lists keep known types once, in a fixed order", () => {
  assert.deepEqual(
    parseWebhookEventTypes([
      "envelope.completed",
      "envelope.sent",
      "envelope.sent",
    ]),
    ["envelope.sent", "envelope.completed"],
  );
  assert.equal(parseWebhookEventTypes([]), null);
  assert.equal(parseWebhookEventTypes(["envelope.deleted"]), null);
  assert.equal(parseWebhookEventTypes("envelope.sent"), null);
});

test("webhook URLs must be public https", () => {
  const env = {};

  assert.equal(
    parseWebhookUrl("https://hooks.example.com/signudoc#x", env).toString(),
    "https://hooks.example.com/signudoc",
  );

  for (const bad of [
    "http://hooks.example.com/",
    "https://127.0.0.1/",
    "https://localhost:3000/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://10.0.0.5/hook",
    "https://user:pass@hooks.example.com/",
    "ftp://hooks.example.com/",
    "not a url",
    "",
  ]) {
    assert.throws(() => parseWebhookUrl(bad, env), bad);
  }
});

test("private URLs are allowed only when asked for, and never on Vercel", () => {
  assert.equal(
    privateWebhookUrlsAllowed({ WEBHOOK_ALLOW_PRIVATE_URLS: "1" }),
    true,
  );
  assert.equal(
    privateWebhookUrlsAllowed({ VERCEL: "1", WEBHOOK_ALLOW_PRIVATE_URLS: "1" }),
    false,
  );
  assert.equal(privateWebhookUrlsAllowed({}), false);
  assert.equal(
    parseWebhookUrl("http://127.0.0.1:4000/hook", {
      WEBHOOK_ALLOW_PRIVATE_URLS: "1",
    }).toString(),
    "http://127.0.0.1:4000/hook",
  );
});

const publicAndPrivate = [
  { address: "203.0.113.10", family: 4 },
  { address: "127.0.0.1", family: 4 },
];

test("a name that resolves to a private address is never called", async () => {
  for (const addresses of [
    [{ address: "10.0.0.5", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "::1", family: 6 }],
    // One private answer among public ones is enough to refuse.
    publicAndPrivate,
  ]) {
    let asked = 0;
    const result = await postWebhook(
      "https://hooks.example.test/signudoc",
      { body: "{}", headers: {} },
      {
        env: {},
        lookup: (_hostname, callback) => {
          asked += 1;
          callback(null, addresses);
        },
      },
    );

    assert.equal(asked, 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.match(
      result.status === null ? result.error : "",
      /private address/,
      JSON.stringify(addresses),
    );
  }
});

test("the request goes to the address that was checked", async () => {
  const { createServer } = await import("node:http");
  const hosts: string[] = [];
  const server = createServer((request, response) => {
    hosts.push(request.headers.host ?? "");
    response.writeHead(204);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as { port: number };

  try {
    // The name exists nowhere but in this lookup, so reaching the server
    // proves the connection used the address the guard was given.
    const result = await postWebhook(
      `http://hooks.example.test:${String(port)}/signudoc`,
      { body: "{}", headers: {} },
      {
        env: { WEBHOOK_ALLOW_PRIVATE_URLS: "1" },
        lookup: (_hostname, callback) => {
          callback(null, [{ address: "127.0.0.1", family: 4 }]);
        },
      },
    );

    assert.equal(result.status, 204);
    assert.deepEqual(hosts, [`hooks.example.test:${String(port)}`]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
