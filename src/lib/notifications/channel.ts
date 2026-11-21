import type { z } from "zod";

import type { EnvSource } from "../utils/env.ts";
import type { NotificationEventKind } from "./events.ts";
import type { NotificationBrand, NotificationMessage } from "./message.ts";
import type { StoredNotificationSettings } from "./store.ts";

// A notification channel: a chat tool notifications can be sent to. Slack
// is the first (slack/channel.ts). Another chat tool would be one more
// implementation of NotificationChannel added to the list in registry.ts;
// the outbox, the rules and the preferences already work for any channel
// by its id.
//
// A channel sends to two kinds of place: a person's direct messages, found
// from their email address (lookupUser), and a shared channel or room the
// administrator picked for a rule (an address the tool itself gave).

export type NotificationChannelId = "slack";

export type ChannelContext = {
  env: EnvSource;
  stored: StoredNotificationSettings;
};

/**
 * What a send or a lookup came to. "retry": try again later, after at
 * least `retryAfterSeconds` when the tool said how long. "rate_limited":
 * the tool asked for a pause; nothing more goes to it until then. "auth":
 * the tool refused the credentials, so nothing to it can work until an
 * administrator fixes them. "failed": this message can never go (an
 * unknown channel, say). `error` is a short code, never a response body.
 */
export type ChannelFailure =
  | { error: string; outcome: "auth" }
  | { error: string; outcome: "failed" }
  | { error: string; outcome: "rate_limited"; retryAfterSeconds: number }
  | { error: string; outcome: "retry"; retryAfterSeconds: number | null };

/**
 * The message a later event about the same envelope edits or replies to:
 * the tool's conversation id and the message's own id (Slack's "ts").
 */
export type ThreadRef = { conversation: string; ts: string };

/**
 * How a message is placed.
 *
 * * "standalone": one message, nothing remembered (the install's own
 *   events, tests).
 * * "channel_thread": the first message about an envelope starts a thread;
 *   later ones edit that first message to show where the envelope stands
 *   and reply in its thread.
 * * "in_place": one message per envelope, edited as it moves along.
 * * "new_message": a new message (an outcome that needs attention), and
 *   the in-place message, if there is one, edited to match.
 */
export type MessagePlacement =
  "channel_thread" | "in_place" | "new_message" | "standalone";

export type SendOptions = {
  placement: MessagePlacement;
  /** The remembered message for this envelope and place, if any. */
  thread: ThreadRef | null;
  /** False when the remembered message already shows a newer event. */
  updateThread: boolean;
};

export const STANDALONE: SendOptions = {
  placement: "standalone",
  thread: null,
  updateThread: false,
};

/** `thread`: the message to remember from now on, or null for none. */
export type SendResult =
  { outcome: "sent"; thread: ThreadRef | null } | ChannelFailure;

export type LookupResult =
  | { externalId: string; outcome: "found" }
  | { outcome: "not_found" }
  | ChannelFailure;

export type ChannelStatus = {
  configured: boolean;
  /** Direct messages to people are turned on. */
  directMessages: boolean;
  /** Where the credentials come from: an environment variable wins. */
  source: "env" | "settings" | null;
};

export interface NotificationChannel {
  readonly id: NotificationChannelId;
  readonly name: string;
  /** Checks a rule's destination before it is saved. */
  readonly destinationSchema: z.ZodType<string>;
  status(context: ChannelContext): ChannelStatus;
  /**
   * Which account the channel sends as, or null when it is not set up: a
   * value that changes whenever the credentials may be another account's
   * (Slack: another workspace). The people and messages remembered for the
   * channel belong to it, and are forgotten when it changes.
   */
  accountKey?(context: ChannelContext): string | null;
  lookupUser(email: string, context: ChannelContext): Promise<LookupResult>;
  send(
    destination: string,
    message: NotificationMessage,
    context: ChannelContext,
    options?: SendOptions,
  ): Promise<SendResult>;
}

/** The answer to a check run from the setup page, in plain words. */
export type ChannelCheckResult = {
  message: string;
  ok: boolean;
};

/** A place in the chat tool a rule can post to, for picking one. */
export type ChannelTarget = {
  id: string;
  /** The app is already in it, so it can post there. */
  isMember: boolean;
  name: string;
};

/** What the setup page and the test messages get from a channel. */
export interface NotificationChannelSetup {
  /** The app's icon on this site, to download and to show in previews. */
  readonly iconPath: string;
  /** Checks a credential pasted in Settings before it is stored. */
  readonly tokenSchema: z.ZodType<string>;
  /** Plain words for an error code the tool gave. */
  describeError(code: string): string;
  /** What to paste into the tool to create the app, or null for nothing. */
  manifest(input: {
    appName: string;
    brandColor: string | null;
    siteUrl: string | null;
  }): string | null;
  /** Asks the tool whose credentials these are. */
  testConnection(context: ChannelContext): Promise<ChannelCheckResult>;
  /** The places a rule can post to, to pick from. */
  listTargets(
    context: ChannelContext,
  ): Promise<
    | { ok: true; targets: ChannelTarget[] }
    | (ChannelCheckResult & { ok: false })
  >;
  /**
   * Sends a sample of `kind`, marked as a test, to a place or to the
   * person with this email address.
   */
  sendTest(
    to: { destination: string } | { email: string },
    sample: {
      appUrl: string | null;
      brand: NotificationBrand;
      kind: NotificationEventKind;
    },
    context: ChannelContext,
  ): Promise<ChannelCheckResult>;
}

/**
 * A sample of one kind of message as the tool shows it, for the setup
 * page: a new message, and the same event as a reply in a thread. The
 * content is the tool's own; its setup section knows how to draw it.
 */
export type ChannelPreview = {
  kind: NotificationEventKind;
  label: string;
  message: unknown;
  reply: unknown;
};

/**
 * A chat tool as the rest of the app sees it, through the registry: how
 * it sends, how it is set up, and what its messages look like. Each tool
 * keeps everything else in its own folder.
 */
export interface NotificationChannelPackage extends NotificationChannel {
  readonly setup: NotificationChannelSetup;
  previews(options: {
    appUrl: string;
    brand: NotificationBrand;
  }): ChannelPreview[];
}

/** Keeps an error code short and free of anything a tool sent back. */
export function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(value)
    ? value
    : "unknown_error";
}
