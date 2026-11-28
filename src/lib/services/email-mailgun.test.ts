import assert from "node:assert/strict";
import { test } from "node:test";

import { type ResolvedSettings } from "../settings.ts";
import {
  createMailgunEmailService,
  describeMailgunEmail,
  retryWaitMs,
} from "./email-mailgun.ts";
import { createEmailService, resolveEmailDriver } from "./email.ts";
import { ServiceConfigurationError } from "./service-config.ts";

const ENV = {
  MAILGUN_API_KEY: "key-test",
  MAILGUN_DOMAIN: "mg.example.test",
  MAILGUN_REGION: "eu",
};

const MESSAGE = {
  attachments: [
    {
      content: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
      filename: "signed.pdf",
    },
  ],
  htmlBody: "<p>Attached.</p>",
  subject: "Your signed copy",
  template: "completion_notification" as const,
  textBody: "Attached.",
  to: "signer@example.test",
};

type Call = { init: RequestInit; url: string };

function fakeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const next = responses[Math.min(calls.length, responses.length - 1)];

    calls.push({ init, url: String(url) });

    return next();
  }) as typeof globalThis.fetch;

  return { calls, fetch };
}

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });

function service(responses: Array<() => Response>) {
  const waits: number[] = [];
  const { calls, fetch } = fakeFetch(responses);
  const mailgun = createMailgunEmailService({
    env: ENV,
    fetch,
    resolveAddresses: async () => ({
      senderAddress: "Example <sign@mg.example.test>",
      supportAddress: "help@example.test",
    }),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  return { calls, mailgun, waits };
}

test("EMAIL_DRIVER=mailgun picks the Mailgun driver", () => {
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: "Mailgun" }), "mailgun");
});

test("the Mailgun driver needs an API key and a sending domain", () => {
  assert.throws(
    () => createEmailService({ env: { EMAIL_DRIVER: "mailgun" } }),
    ServiceConfigurationError,
  );
});

test("an unknown MAILGUN_REGION is refused", () => {
  assert.throws(
    () =>
      createEmailService({
        env: { ...ENV, EMAIL_DRIVER: "mailgun", MAILGUN_REGION: "asia" },
      }),
    /MAILGUN_REGION/,
  );
});

test("a message is posted to the domain's messages endpoint in its region", async () => {
  const { calls, mailgun } = service([
    () => json(200, { id: "<1@mg.example.test>", message: "Queued." }),
  ]);

  const result = await mailgun.send(MESSAGE);

  assert.deepEqual(result, {
    accepted: ["signer@example.test"],
    messageId: "<1@mg.example.test>",
    rejected: [],
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.eu.mailgun.net/v3/mg.example.test/messages",
  );
  assert.equal(
    (calls[0].init.headers as Record<string, string>).authorization,
    `Basic ${Buffer.from("api:key-test").toString("base64")}`,
  );

  const form = calls[0].init.body as FormData;

  assert.equal(form.get("from"), "Example <sign@mg.example.test>");
  assert.equal(form.get("to"), "signer@example.test");
  assert.equal(form.get("subject"), "Your signed copy");
  assert.equal(form.get("text"), "Attached.");
  assert.equal(form.get("html"), "<p>Attached.</p>");
  assert.equal(form.get("h:Reply-To"), "help@example.test");
  assert.equal(form.get("o:tag"), "completion_notification");

  const attachment = form.get("attachment") as File;

  assert.equal(attachment.name, "signed.pdf");
  assert.equal(attachment.type, "application/pdf");
  assert.deepEqual(
    new Uint8Array(await attachment.arrayBuffer()),
    MESSAGE.attachments[0].content,
  );
});

test("a send turned away for rate or by a fault is tried again", async () => {
  const { calls, mailgun, waits } = service([
    () => json(429, { message: "Too many" }, { "retry-after": "2" }),
    () => json(503, { message: "Unavailable" }),
    () => json(200, { id: "<2@mg.example.test>" }),
  ]);

  const result = await mailgun.send(MESSAGE);

  assert.equal(result.messageId, "<2@mg.example.test>");
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [2_000, 1_000]);
});

test("a send told to wait longer than a request can is not retried", async () => {
  const { calls, mailgun, waits } = service([
    () => json(429, { message: "Too many" }, { "retry-after": "60" }),
  ]);

  await assert.rejects(mailgun.send(MESSAGE), /Too many/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("Retry-After is read in seconds or as an HTTP date", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const after = (value: string) =>
    retryWaitMs(new Response(null, { headers: { "retry-after": value } }), now);

  assert.equal(after("3"), 3_000);
  assert.equal(after("Thu, 01 Jan 2026 00:00:04 GMT"), 4_000);
  assert.equal(retryWaitMs(new Response(null), now), 1_000);
});

test("each Mailgun request carries a timeout", async () => {
  const { calls, mailgun } = service([() => json(200, { id: "<1@x>" })]);

  await mailgun.send(MESSAGE);

  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("a refusal is reported in Mailgun's words and not retried", async () => {
  const { calls, mailgun } = service([
    () => json(400, { message: "to parameter is not a valid address" }),
  ]);

  await assert.rejects(mailgun.send(MESSAGE), /not a valid address/);
  assert.equal(calls.length, 1);
});

test("a batch is sent one message at a time", async () => {
  const { calls, mailgun } = service([() => json(200, { id: "<3@x>" })]);

  const results = await mailgun.sendBatch([
    { ...MESSAGE, attachments: undefined },
    { ...MESSAGE, attachments: undefined, to: "second@example.test" },
  ]);

  assert.equal(results.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(
    (calls[1].init.body as FormData).get("to"),
    "second@example.test",
  );
});

function settingsWithSender(senderAddress: string | null) {
  return {
    emailReadyAt: null,
    organizationName: "Example",
    senderAddress,
  } as unknown as ResolvedSettings;
}

async function describe(
  senderAddress: string | null,
  responses: Array<() => Response> = [
    () => json(200, { domain: { state: "active" } }),
  ],
) {
  const marks: boolean[] = [];
  const { calls, fetch } = fakeFetch(responses);
  const status = await describeMailgunEmail({
    env: ENV,
    fetch,
    markReady: async (ready) => {
      marks.push(ready);
    },
    settings: settingsWithSender(senderAddress),
  });

  return { calls, marks, status };
}

test("Settings asks for a sender address when none is set", async () => {
  const { calls, status } = await describe(null);

  assert.equal(status.state, "mailgun");
  assert.equal(status.state === "mailgun" && status.problem, "no_sender");
  assert.equal(calls.length, 0);
});

test("Settings says when the sender is not at the Mailgun domain", async () => {
  const { marks, status } = await describe("sign@other.test");

  assert.equal(status.state === "mailgun" && status.problem, "wrong_domain");
  assert.deepEqual(marks, [false]);
});

test("email is ready once Mailgun says the domain is active", async () => {
  const { calls, marks, status } = await describe("sign@mg.example.test");

  assert.deepEqual(status, {
    domain: "mg.example.test",
    senderAddress: "sign@mg.example.test",
    state: "ready",
  });
  assert.deepEqual(marks, [true]);
  assert.equal(
    calls[0].url,
    "https://api.eu.mailgun.net/v4/domains/mg.example.test",
  );
});

test("a domain Mailgun has not verified is reported as unverified", async () => {
  const { marks, status } = await describe("sign@mg.example.test", [
    () => json(200, { domain: { state: "unverified" } }),
  ]);

  assert.equal(status.state === "mailgun" && status.problem, "unverified");
  assert.deepEqual(marks, [false]);
});

test("an error from Mailgun leaves the ready mark as it is", async () => {
  const { marks, status } = await describe("sign@mg.example.test", [
    () => json(401, { message: "Invalid private key" }),
  ]);

  assert.equal(status.state === "mailgun" && status.problem, "error");
  assert.equal(
    status.state === "mailgun" && status.message,
    "Invalid private key",
  );
  assert.deepEqual(marks, []);
});

test("Settings names the missing Mailgun settings instead of failing", async () => {
  const marks: boolean[] = [];
  const status = await describeMailgunEmail({
    env: { MAILGUN_DOMAIN: "mg.example.test" },
    fetch: (async () => {
      throw new Error("not called");
    }) as typeof fetch,
    markReady: async (ready) => {
      marks.push(ready);
    },
    settings: settingsWithSender("sign@mg.example.test"),
  });

  assert.equal(status.state, "mailgun");
  assert.equal(status.state === "mailgun" && status.problem, "config");
  assert.match(
    (status.state === "mailgun" && status.message) || "",
    /MAILGUN_API_KEY/,
  );
  assert.deepEqual(marks, [false]);
});
