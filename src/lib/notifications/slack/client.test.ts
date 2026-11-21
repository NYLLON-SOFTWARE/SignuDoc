import assert from "node:assert/strict";
import { test } from "node:test";

import { notificationEventKinds } from "../events.ts";
import {
  buildNotificationMessage,
  type NotificationMessage,
} from "../message.ts";
import {
  createSlackChannelWithFetch,
  escapeSlackText,
  resolveSlackToken,
  slackBotTokenSchema,
} from "./channel.ts";
import {
  classifySlackError,
  createSlackClient,
  type SlackFetch,
} from "./client.ts";
import { buildSlackMessage, SLACK_TONE_COLORS } from "./layout.ts";
import {
  buildSlackManifest,
  SLACK_BOT_SCOPES,
  slackBackgroundColor,
} from "./manifest.ts";
import { buildSlackPreviews } from "./preview.ts";
import { buildSlackTestMessage, describeSlackError } from "./setup.ts";
import { EMPTY_NOTIFICATION_SETTINGS } from "../store.ts";

// The Slack client against a fake fetch: what it sends, how it reads
// Slack's answers, and that a failure keeps only Slack's status and error
// code.

type Call = { body: string; headers: Record<string, string>; url: string };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): {
  calls: Call[];
  fetch: SlackFetch;
} {
  const calls: Call[] = [];

  return {
    calls,
    fetch: async (url, init) => {
      const call = {
        body: String(init.body ?? ""),
        headers: init.headers as Record<string, string>,
        url,
      };

      calls.push(call);

      return respond(call);
    },
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

const TOKEN = "xoxb-1234567890-abcdefghij";

test("users.lookupByEmail is sent form-encoded with the bot token", async () => {
  const { calls, fetch } = fakeFetch(() =>
    json({ ok: true, user: { id: "U012345", name: "riley" } }),
  );
  const client = createSlackClient({ fetch, token: TOKEN });
  const result = await client.lookupUserByEmail("riley@example.com");

  assert.deepEqual(result, { ok: true, userId: "U012345" });
  assert.equal(calls[0]?.url, "https://slack.com/api/users.lookupByEmail");
  assert.equal(calls[0]?.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(
    calls[0]?.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(calls[0]?.body, "email=riley%40example.com");
});

test("nobody with that address, or a deactivated account, is not found", async () => {
  const missing = createSlackClient({
    fetch: fakeFetch(() => json({ error: "users_not_found", ok: false })).fetch,
    token: TOKEN,
  });
  const deleted = createSlackClient({
    fetch: fakeFetch(() =>
      json({ ok: true, user: { deleted: true, id: "U0GONE" } }),
    ).fetch,
    token: TOKEN,
  });

  assert.equal((await missing.lookupUserByEmail("a@example.com")).ok, false);
  assert.deepEqual(await deleted.lookupUserByEmail("a@example.com"), {
    error: "users_not_found",
    ok: false,
    retryAfterSeconds: null,
    status: 200,
  });
});

test("chat.postMessage is sent as JSON, without unfurling or mentions", async () => {
  const { calls, fetch } = fakeFetch(() =>
    json({ channel: "C0123456", ok: true, ts: "1700000000.000100" }),
  );
  const client = createSlackClient({ fetch, token: TOKEN });
  const result = await client.postMessage({
    blocks: [{ type: "section" }],
    channel: "C0123456",
    text: "Hello",
  });

  assert.deepEqual(result, {
    channel: "C0123456",
    ok: true,
    ts: "1700000000.000100",
  });
  assert.equal(calls[0]?.url, "https://slack.com/api/chat.postMessage");
  assert.equal(
    calls[0]?.headers["content-type"],
    "application/json; charset=utf-8",
  );

  const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;

  assert.equal(body.channel, "C0123456");
  assert.equal(body.text, "Hello");
  assert.equal(body.link_names, false);
  assert.equal(body.unfurl_links, false);
  assert.deepEqual(body.blocks, [{ type: "section" }]);
});

test("a rate limit keeps Slack's Retry-After", async () => {
  const client = createSlackClient({
    fetch: fakeFetch(
      () =>
        new Response("slow down", {
          headers: { "retry-after": "42" },
          status: 429,
        }),
    ).fetch,
    token: TOKEN,
  });
  const result = await client.postMessage({ channel: "C0123456", text: "x" });

  assert.deepEqual(result, {
    error: "ratelimited",
    ok: false,
    retryAfterSeconds: 42,
    status: 429,
  });
  assert.ok(!result.ok);
  assert.deepEqual(classifySlackError(result), {
    error: "ratelimited",
    outcome: "rate_limited",
    retryAfterSeconds: 42,
  });
});

test("a rate limit without Retry-After waits a default time", async () => {
  const client = createSlackClient({
    fetch: fakeFetch(() => new Response(null, { status: 429 })).fetch,
    token: TOKEN,
  });
  const result = await client.authTest();

  assert.ok(!result.ok);
  assert.equal(result.retryAfterSeconds, 30);
});

test("errors are classified by status and code alone", () => {
  const base = { ok: false as const, retryAfterSeconds: null, status: 200 };

  assert.equal(
    classifySlackError({ ...base, error: "invalid_auth" }).outcome,
    "auth",
  );
  assert.equal(
    classifySlackError({ ...base, error: "token_revoked" }).outcome,
    "auth",
  );
  assert.equal(
    classifySlackError({ ...base, error: "channel_not_found" }).outcome,
    "failed",
  );
  assert.equal(
    classifySlackError({ ...base, error: "not_in_channel" }).outcome,
    "failed",
  );
  assert.equal(
    classifySlackError({ ...base, error: "internal_error" }).outcome,
    "retry",
  );
  assert.equal(
    classifySlackError({ ...base, error: "http_503", status: 503 }).outcome,
    "retry",
  );
  assert.equal(
    classifySlackError({ ...base, error: "network_error", status: 0 }).outcome,
    "retry",
  );
});

test("a failed call keeps no part of what Slack sent back but a safe code", async () => {
  const leaky = createSlackClient({
    fetch: fakeFetch(() =>
      json({
        error: "<script>secret xoxb-leak</script>",
        ok: false,
        warning: "something private",
      }),
    ).fetch,
    token: TOKEN,
  });
  const result = await leaky.authTest();

  assert.deepEqual(result, {
    error: "unknown_error",
    ok: false,
    retryAfterSeconds: null,
    status: 200,
  });

  const broken = createSlackClient({
    fetch: fakeFetch(
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    ).fetch,
    token: TOKEN,
  });

  assert.deepEqual(await broken.authTest(), {
    error: "http_502",
    ok: false,
    retryAfterSeconds: null,
    status: 502,
  });
});

test("a network failure is a retry, not a crash", async () => {
  const client = createSlackClient({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
    token: TOKEN,
  });
  const result = await client.postMessage({ channel: "C0123456", text: "x" });

  assert.ok(!result.ok);
  assert.equal(result.error, "network_error");
  assert.equal(classifySlackError(result).outcome, "retry");
});

test("auth.test and conversations.list are read", async () => {
  const { calls, fetch } = fakeFetch((call) =>
    call.url.endsWith("auth.test")
      ? json({ ok: true, team: "Example", team_id: "T1", user_id: "U1" })
      : json({
          channels: [
            { id: "C1", is_member: true, name: "sales" },
            { id: "C2", name: "general" },
            { name: "no-id" },
          ],
          ok: true,
          response_metadata: { next_cursor: "" },
        }),
  );
  const client = createSlackClient({ fetch, token: TOKEN });

  assert.deepEqual(await client.authTest(), {
    botUserId: "U1",
    ok: true,
    team: "Example",
    teamId: "T1",
    url: null,
  });
  assert.deepEqual(await client.listChannels(), {
    channels: [
      { id: "C1", isMember: true, isPrivate: false, name: "sales" },
      { id: "C2", isMember: false, isPrivate: false, name: "general" },
    ],
    nextCursor: null,
    ok: true,
  });
  assert.match(calls[1]?.body ?? "", /types=public_channel/);
  assert.match(calls[1]?.body ?? "", /exclude_archived=true/);
});

function sample(
  overrides: Partial<Parameters<typeof buildNotificationMessage>[0]> = {},
): NotificationMessage {
  return buildNotificationMessage({
    appUrl: "https://sign.example.com",
    brand: {
      logoUrl: "https://sign.example.com/api/brand/logo?v=1",
      name: "Acme <Corp>",
    },
    envelope: {
      expiresAt: null,
      id: "e1",
      ownerEmail: "sam@example.com",
      ownerName: "Sam Rivera",
      signedCount: 2,
      signerCount: 3,
      status: "sent",
      title: "NDA <v2> & *more*",
    },
    kind: "envelope_signed",
    occurredAt: 1_900_000_000,
    payload: { signerEmail: "riley@example.com", signerName: "Riley" },
    ...overrides,
  });
}

type Body = {
  attachments?: {
    blocks: {
      elements?: { style?: string; text?: unknown; url?: string }[];
      text?: { text: string };
      type: string;
    }[];
    color: string;
  }[];
  blocks?: {
    elements?: { image_url?: string; text?: string; type: string }[];
    text?: { text: string };
    type: string;
  }[];
  channel?: string;
  text: string;
  thread_ts?: string;
  ts?: string;
};

function bodyOf(call: Call | undefined): Body {
  return JSON.parse(call?.body ?? "{}") as Body;
}

test("the channel looks people up and sends Block Kit messages", async () => {
  const { calls, fetch } = fakeFetch((call) =>
    call.url.endsWith("users.lookupByEmail")
      ? json({ ok: true, user: { id: "U777" } })
      : json({ channel: "D777", ok: true, ts: "1.2" }),
  );
  const channel = createSlackChannelWithFetch(fetch);
  const context = {
    env: { SLACK_BOT_TOKEN: TOKEN },
    stored: EMPTY_NOTIFICATION_SETTINGS,
  };

  assert.deepEqual(await channel.lookupUser("a@example.com", context), {
    externalId: "U777",
    outcome: "found",
  });
  assert.deepEqual(await channel.send("U777", sample(), context), {
    outcome: "sent",
    thread: null,
  });

  const body = bodyOf(calls[1]);

  assert.equal(
    body.text,
    "Riley signed NDA &lt;v2&gt; &amp; *more* — 2 of 3 signed · Out for signature · Sent by Sam Rivera",
  );
});

test("every message has the same layout: organization, coloured body, buttons", () => {
  const content = buildSlackMessage(sample(), "message");

  // The organization on top, with its logo.
  assert.deepEqual(content.blocks, [
    {
      elements: [
        {
          alt_text: "Acme &lt;Corp&gt;",
          image_url: "https://sign.example.com/api/brand/logo?v=1",
          type: "image",
        },
        { text: "*Acme &lt;Corp&gt;*", type: "mrkdwn" },
      ],
      type: "context",
    },
  ]);

  const [attachment] = content.attachments ?? [];

  assert.equal(attachment?.color, SLACK_TONE_COLORS.progress);
  assert.deepEqual(
    attachment?.blocks.map((block) => block.type),
    ["section", "context", "actions"],
  );
  // The title is bold and escaped; its own asterisks cannot end the bold.
  assert.deepEqual(attachment?.blocks[0], {
    text: {
      text: ":writing_hand:  Riley signed *NDA &lt;v2&gt; &amp; ∗more∗* — 2 of 3 signed",
      type: "mrkdwn",
    },
    type: "section",
  });
  assert.deepEqual(attachment?.blocks[1], {
    elements: [
      {
        text: "Out for signature  ·  Sent by Sam Rivera  ·  <!date^1900000000^{date_short_pretty} at {time}|Mar 17, 2030>",
        type: "mrkdwn",
      },
    ],
    type: "context",
  });
  assert.deepEqual(attachment?.blocks[2], {
    elements: [
      {
        action_id: "open",
        text: { emoji: false, text: "Open envelope", type: "plain_text" },
        type: "button",
        url: "https://sign.example.com/envelopes/e1",
      },
    ],
    type: "actions",
  });

  // Every kind has its colour and its emoji, and a text fallback.
  for (const kind of notificationEventKinds) {
    const each = buildSlackMessage(sample({ kind }));
    const headline = each.attachments?.[0]?.blocks[0]?.text as
      { text?: string } | undefined;

    assert.ok(each.text.length > 0);
    assert.match(headline?.text ?? "", /^:[a-z_]+: {2}/);
  }
});

test("a completed envelope offers its certificate, in green", () => {
  const content = buildSlackMessage(
    sample({
      envelope: {
        expiresAt: null,
        id: "e1",
        ownerEmail: "sam@example.com",
        ownerName: "Sam Rivera",
        signedCount: 3,
        signerCount: 3,
        status: "completed",
        title: "NDA",
      },
      kind: "envelope_completed",
    }),
  );
  const attachment = content.attachments?.[0];
  const buttons = attachment?.blocks.at(-1)?.elements as
    { style?: string; text: { text: string }; url: string }[] | undefined;

  assert.equal(attachment?.color, SLACK_TONE_COLORS.success);
  assert.deepEqual(
    buttons?.map((button) => [button.text.text, button.style ?? null]),
    [
      ["View certificate", "primary"],
      ["Open envelope", null],
    ],
  );
  assert.equal(
    buttons?.[0]?.url,
    "https://sign.example.com/envelopes/e1/certificate",
  );
});

test("a reply in a thread leads with the headline and leaves out the organization and Open envelope", () => {
  const content = buildSlackMessage(sample(), "reply");

  assert.equal(content.blocks?.length, 1);
  assert.equal(content.blocks?.[0]?.type, "section");
  assert.deepEqual(
    content.attachments?.[0]?.blocks.map((block) => block.type),
    ["context"],
  );
});

test("a first message in a channel starts a thread; later ones edit it and reply in it", async () => {
  const { calls, fetch } = fakeFetch(() =>
    json({ channel: "C0123456", ok: true, ts: "100.1" }),
  );
  const channel = createSlackChannelWithFetch(fetch);
  const context = {
    env: { SLACK_BOT_TOKEN: TOKEN },
    stored: EMPTY_NOTIFICATION_SETTINGS,
  };

  const first = await channel.send("C0123456", sample(), context, {
    placement: "channel_thread",
    thread: null,
    updateThread: true,
  });

  assert.deepEqual(first, {
    outcome: "sent",
    thread: { conversation: "C0123456", ts: "100.1" },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? "", /chat\.postMessage$/);
  assert.equal(bodyOf(calls[0]).thread_ts, undefined);

  const later = await channel.send(
    "C0123456",
    sample({ kind: "envelope_completed" }),
    context,
    {
      placement: "channel_thread",
      thread: { conversation: "C0123456", ts: "100.1" },
      updateThread: true,
    },
  );

  assert.deepEqual(later, {
    outcome: "sent",
    thread: { conversation: "C0123456", ts: "100.1" },
  });
  assert.match(calls[1]?.url ?? "", /chat\.update$/);
  assert.equal(bodyOf(calls[1]).ts, "100.1");
  assert.match(calls[2]?.url ?? "", /chat\.postMessage$/);
  assert.equal(bodyOf(calls[2]).thread_ts, "100.1");
});

test("a deleted channel thread is started again", async () => {
  const { calls, fetch } = fakeFetch((call) => {
    if (call.url.endsWith("chat.update")) {
      return json({ channel: "C0123456", ok: true, ts: "100.1" });
    }

    // The reply into the thread finds the first message gone.
    return bodyOf(call).thread_ts
      ? json({ error: "thread_not_found", ok: false })
      : json({ channel: "C0123456", ok: true, ts: "300.3" });
  });
  const channel = createSlackChannelWithFetch(fetch);
  const context = {
    env: { SLACK_BOT_TOKEN: TOKEN },
    stored: EMPTY_NOTIFICATION_SETTINGS,
  };
  const result = await channel.send("C0123456", sample(), context, {
    placement: "channel_thread",
    thread: { conversation: "C0123456", ts: "100.1" },
    updateThread: true,
  });

  assert.deepEqual(result, {
    outcome: "sent",
    thread: { conversation: "C0123456", ts: "300.3" },
  });
  assert.deepEqual(
    calls.map((call) => call.url.split("/").at(-1)),
    ["chat.update", "chat.postMessage", "chat.postMessage"],
  );
  assert.equal(bodyOf(calls[1]).thread_ts, "100.1");
  assert.equal(bodyOf(calls[2]).thread_ts, undefined);
});

test("a deleted first message is replaced by a new one", async () => {
  const { calls, fetch } = fakeFetch((call) =>
    call.url.endsWith("chat.update")
      ? json({ error: "message_not_found", ok: false })
      : json({ channel: "D0123456", ok: true, ts: "200.2" }),
  );
  const channel = createSlackChannelWithFetch(fetch);
  const context = {
    env: { SLACK_BOT_TOKEN: TOKEN },
    stored: EMPTY_NOTIFICATION_SETTINGS,
  };
  const result = await channel.send("U777", sample(), context, {
    placement: "in_place",
    thread: { conversation: "D0123456", ts: "100.1" },
    updateThread: true,
  });

  assert.deepEqual(result, {
    outcome: "sent",
    thread: { conversation: "D0123456", ts: "200.2" },
  });
  assert.deepEqual(
    calls.map((call) => call.url.split("/").at(-1)),
    ["chat.update", "chat.postMessage"],
  );
});

test("an outcome posts a new direct message and brings the progress message up to date", async () => {
  const { calls, fetch } = fakeFetch(() =>
    json({ channel: "D0123456", ok: true, ts: "300.3" }),
  );
  const channel = createSlackChannelWithFetch(fetch);
  const context = {
    env: { SLACK_BOT_TOKEN: TOKEN },
    stored: EMPTY_NOTIFICATION_SETTINGS,
  };
  const progress = { conversation: "D0123456", ts: "100.1" };
  const result = await channel.send(
    "U777",
    sample({ kind: "envelope_declined" }),
    context,
    { placement: "new_message", thread: progress, updateThread: true },
  );

  assert.deepEqual(result, { outcome: "sent", thread: progress });
  assert.deepEqual(
    calls.map((call) => call.url.split("/").at(-1)),
    ["chat.update", "chat.postMessage"],
  );
  assert.equal(bodyOf(calls[1]).channel, "U777");
});

test("a failed edit is a failed send, kept to Slack's error code", async () => {
  const { fetch } = fakeFetch(() =>
    json({ error: "internal_error", ok: false }),
  );
  const channel = createSlackChannelWithFetch(fetch);
  const result = await channel.send(
    "C0123456",
    sample(),
    { env: { SLACK_BOT_TOKEN: TOKEN }, stored: EMPTY_NOTIFICATION_SETTINGS },
    {
      placement: "channel_thread",
      thread: { conversation: "C0123456", ts: "1.1" },
      updateThread: true,
    },
  );

  assert.deepEqual(result, {
    error: "internal_error",
    outcome: "retry",
    retryAfterSeconds: null,
  });
});

test("without a token the channel is not set up and sends nothing", async () => {
  const { calls, fetch } = fakeFetch(() => json({ ok: true }));
  const channel = createSlackChannelWithFetch(fetch);
  const context = { env: {}, stored: EMPTY_NOTIFICATION_SETTINGS };

  assert.deepEqual(channel.status(context), {
    configured: false,
    directMessages: false,
    source: null,
  });
  assert.equal((await channel.send("C1", sample(), context)).outcome, "failed");
  assert.equal(calls.length, 0);
});

test("the environment's token wins over the stored one, and direct messages can be off", () => {
  assert.deepEqual(
    resolveSlackToken(
      { SLACK_BOT_TOKEN: "xoxb-from-environment-1" },
      {
        ...EMPTY_NOTIFICATION_SETTINGS,
        slackBotToken: "xoxb-from-settings-1",
      },
    ),
    { source: "env", token: "xoxb-from-environment-1" },
  );
  assert.deepEqual(
    resolveSlackToken(
      {},
      {
        ...EMPTY_NOTIFICATION_SETTINGS,
        slackBotToken: "xoxb-from-settings-1",
      },
    ),
    { source: "settings", token: "xoxb-from-settings-1" },
  );

  const channel = createSlackChannelWithFetch(async () => json({ ok: true }));

  assert.equal(
    channel.status({
      env: {},
      stored: {
        ...EMPTY_NOTIFICATION_SETTINGS,
        directMessages: false,
        slackBotToken: "xoxb-from-settings-1",
      },
    }).directMessages,
    false,
  );
});

test("only bot tokens are accepted", () => {
  assert.equal(slackBotTokenSchema.safeParse(TOKEN).success, true);
  assert.equal(
    slackBotTokenSchema.safeParse("xoxp-1234567890-abc").success,
    false,
  );
  assert.equal(slackBotTokenSchema.safeParse("hello").success, false);
});

test("text is escaped so a title cannot become a mention or a link", () => {
  assert.equal(
    escapeSlackText("<!channel> & <https://evil.example|click>"),
    "&lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;",
  );

  const content = buildSlackMessage(
    sample({ payload: { signerName: "<@U1> <!here>" } }),
  );
  const everything = JSON.stringify(content);

  assert.doesNotMatch(everything, /<@U1>|<!here>/);
  assert.match(everything, /&lt;@U1&gt; &lt;!here&gt;/);
});

test("previews show every kind, built like the real messages", () => {
  const previews = buildSlackPreviews({
    appUrl: "https://sign.example.com",
    brand: { logoUrl: null, name: "Acme" },
  });

  assert.deepEqual(
    previews.map((preview) => preview.kind),
    [...notificationEventKinds],
  );

  for (const preview of previews) {
    assert.equal(preview.message.blocks?.[0]?.type, "context");
    // A reply in a thread leaves out the organization line on top.
    assert.notEqual(preview.reply.blocks?.[0]?.type, "context", preview.kind);
  }
});

test("the manifest asks for the minimal scopes and names this site", () => {
  const manifest = buildSlackManifest({
    appName: "Example",
    brandColor: "#0b5394",
    siteUrl: "https://sign.example.com",
  }) as {
    display_information: {
      background_color: string;
      description: string;
      long_description: string;
      name: string;
    };
    oauth_config: { scopes: { bot: string[] } };
  };

  // Slack wants 175 to 4,000 characters here, and no more than 140 in the
  // short description.
  assert.ok(manifest.display_information.long_description.length >= 175);
  assert.ok(manifest.display_information.long_description.length <= 4000);
  assert.equal(manifest.display_information.background_color, "#0b5394");

  assert.deepEqual(manifest.oauth_config.scopes.bot, [...SLACK_BOT_SCOPES]);
  assert.deepEqual(manifest.oauth_config.scopes.bot, [
    "chat:write",
    "users:read",
    "users:read.email",
    "channels:read",
  ]);
  assert.equal(
    manifest.display_information.description,
    "Updates on documents sent for signature on sign.example.com.",
  );
  assert.ok(manifest.display_information.description.length <= 140);
  assert.equal(manifest.display_information.name, "Example");
});

test("the app's background is the organization's colour only when white text reads on it", () => {
  assert.equal(slackBackgroundColor("#0B5394"), "#0b5394");
  assert.equal(slackBackgroundColor("#ffe066"), "#5340d6");
  assert.equal(slackBackgroundColor(null), "#5340d6");
  assert.equal(slackBackgroundColor("not a colour"), "#5340d6");
});

test("locally made client errors are not described as Slack's answer", () => {
  for (const code of ["network_error", "timeout", "invalid_response"]) {
    assert.doesNotMatch(describeSlackError(code), /Slack answered/);
  }

  const http = describeSlackError("http_503");

  assert.doesNotMatch(http, /Slack answered/);
  assert.match(http, /503/);
});

function collectButtons(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectButtons(item, found);
    }
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;

    if (record.type === "button") {
      found.push(record);
    }

    for (const child of Object.values(record)) {
      collectButtons(child, found);
    }
  }

  return found;
}

test("button text stays within Block Kit's 75 characters, even with a long name", () => {
  const content = buildSlackTestMessage("envelope_completed", {
    appUrl: "https://sign.example.test",
    brand: { logoUrl: null, name: "N".repeat(120) },
  });
  const buttons = collectButtons(content) as {
    text: { text: string };
  }[];

  assert.ok(buttons.length > 0);

  for (const button of buttons) {
    assert.ok(
      button.text.text.length <= 75,
      `button text is ${String(button.text.text.length)} characters`,
    );
  }
});
