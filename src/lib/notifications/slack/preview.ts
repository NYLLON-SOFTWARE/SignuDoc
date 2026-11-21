import {
  listNotificationEvents,
  type NotificationEventKind,
} from "../events.ts";
import {
  buildNotificationMessage,
  type NotificationBrand,
  type NotificationEnvelope,
  type NotificationMessage,
  type NotificationPayload,
} from "../message.ts";
import type { SlackMessageContent } from "./client.ts";
import { buildSlackMessage } from "./layout.ts";

// Sample messages for the settings page (a preview of each kind) and for a
// rule's "Send test". They are built by the same functions as the real
// ones, from a made-up envelope, so what the page shows is what Slack gets.

export type SlackPreview = {
  kind: NotificationEventKind;
  label: string;
  /** A new message, a direct message, or a thread's first message. */
  message: SlackMessageContent;
  /** The same event as a reply in a channel's thread. */
  reply: SlackMessageContent;
};

/** A fixed moment, so a preview does not change between renders. */
const SAMPLE_TIME = 1_796_131_800;
const DAY = 24 * 60 * 60;

function sampleEnvelope(kind: NotificationEventKind): NotificationEnvelope {
  const signedCount =
    kind === "envelope_completed"
      ? 3
      : kind === "envelope_sent" || kind === "envelope_viewed"
        ? 0
        : kind === "envelope_stuck"
          ? 0
          : 2;
  const status =
    kind === "envelope_completed"
      ? "completed"
      : kind === "envelope_declined"
        ? "declined"
        : kind === "envelope_voided"
          ? "voided"
          : "sent";

  return {
    expiresAt: SAMPLE_TIME + 3 * DAY,
    id: "sample",
    ownerEmail: "sam.rivera@example.com",
    ownerName: "Sam Rivera",
    signedCount,
    signerCount: 3,
    status,
    title: "Acme master services agreement",
  };
}

const SAMPLE_PAYLOAD: NotificationPayload = {
  expiresAt: SAMPLE_TIME + 3 * DAY,
  idleDays: 7,
  signerEmail: "alex.chen@example.com",
  signerName: "Alex Chen",
};

/** The message a sample event makes, as the sender would get it. */
export function buildSampleMessage(
  kind: NotificationEventKind,
  { appUrl, brand }: { appUrl: string | null; brand: NotificationBrand },
): NotificationMessage {
  return buildNotificationMessage({
    appUrl,
    brand,
    envelope: sampleEnvelope(kind),
    forSender: true,
    kind,
    occurredAt: SAMPLE_TIME,
    payload: SAMPLE_PAYLOAD,
  });
}

/** A preview of every kind, in the order the pages list them. */
export function buildSlackPreviews(options: {
  appUrl: string | null;
  brand: NotificationBrand;
}): SlackPreview[] {
  return listNotificationEvents().map((event) => {
    const message = buildSampleMessage(event.kind, options);

    return {
      kind: event.kind,
      label: event.label,
      message: buildSlackMessage(message, "message"),
      reply: buildSlackMessage(message, "reply"),
    };
  });
}
