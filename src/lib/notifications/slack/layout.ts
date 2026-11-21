import type { NotificationEventKind } from "../events.ts";
import {
  formatNotificationDate,
  type HeadlinePart,
  type NotificationMessage,
  type NotificationTone,
} from "../message.ts";
import type { SlackBlock, SlackMessageContent } from "./client.ts";

// How a notification looks in Slack. Every message has the same shape:
//
//   [logo] Organization name                       (context, on top)
//   | :emoji: Alex Chen signed *Acme MSA* — 2 of 3 signed
//   | Out for signature · Sent by Sam Rivera · Due Dec 3 · <when>
//   | [View certificate] [Open envelope]
//
// The bar down the left (an attachment's colour) says what kind of news it
// is: blue for progress, green for done, amber for a warning, red for an
// end that went wrong, grey for a withdrawn envelope. A reply in a
// channel's thread is the same, without the organization line.
//
// Everything a person typed (a title, a name) is escaped, so it can never
// become a mention or a link. Pure: the settings page previews messages
// with these same functions.

export const SLACK_TONE_COLORS: Record<NotificationTone, string> = {
  danger: "#e01e5a",
  neutral: "#9ca3af",
  progress: "#1d9bd1",
  success: "#2eb67d",
  warning: "#ecb22e",
};

/** Slack's emoji for each kind, by its short name. */
export const SLACK_EVENT_EMOJI: Record<NotificationEventKind, string> = {
  envelope_completed: ":white_check_mark:",
  envelope_declined: ":x:",
  envelope_expired: ":hourglass:",
  envelope_expiring_soon: ":alarm_clock:",
  envelope_sent: ":outbox_tray:",
  envelope_signed: ":writing_hand:",
  envelope_stuck: ":hourglass_flowing_sand:",
  envelope_viewed: ":eyes:",
  envelope_voided: ":no_entry_sign:",
};

/** Keeps Slack from reading a title or a name as a link or a mention. */
export function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Bold without letting the text's own asterisks end the bold early. */
function strong(text: string): string {
  const clean = escapeSlackText(text).replace(/\*/g, "∗").trim();

  return clean ? `*${clean}*` : "";
}

export function headlineMarkup(headline: HeadlinePart[]): string {
  return headline
    .map((part) =>
      part.strong ? strong(part.text) : escapeSlackText(part.text),
    )
    .join("");
}

/**
 * A date Slack shows in each reader's own time zone, with a fallback for
 * clients that cannot.
 */
export function slackDate(unixSeconds: number): string {
  const seconds = Math.floor(unixSeconds);

  return `<!date^${String(seconds)}^{date_short_pretty} at {time}|${escapeSlackText(formatNotificationDate(seconds))}>`;
}

function detailsLine(message: NotificationMessage, reply: boolean): string {
  const parts = (reply ? message.details.slice(0, 2) : message.details).map(
    escapeSlackText,
  );

  if (message.occurredAt !== null) {
    parts.push(slackDate(message.occurredAt));
  }

  return parts.join("  ·  ");
}

/** Block Kit allows at most 75 characters of button text. */
const MAX_BUTTON_TEXT = 75;

function clampButtonText(label: string): string {
  return label.length <= MAX_BUTTON_TEXT
    ? label
    : `${label.slice(0, MAX_BUTTON_TEXT - 1).trimEnd()}…`;
}

function actionsBlock(
  message: NotificationMessage,
  reply: boolean,
): SlackBlock | null {
  // A reply sits under the first message, which already opens the
  // envelope; it only keeps a button that is new (a certificate, say).
  const actions = reply
    ? message.actions.filter((action) => action.id !== "open")
    : message.actions;

  if (actions.length === 0) {
    return null;
  }

  return {
    elements: actions.map((action) => ({
      action_id: action.id,
      text: {
        emoji: false,
        text: clampButtonText(action.label),
        type: "plain_text",
      },
      type: "button",
      url: action.url,
      ...(action.primary ? { style: "primary" } : {}),
    })),
    type: "actions",
  };
}

function brandBlock(message: NotificationMessage): SlackBlock {
  const elements: SlackBlock[] = [];

  if (message.brand.logoUrl) {
    elements.push({
      alt_text: escapeSlackText(message.brand.name),
      image_url: message.brand.logoUrl,
      type: "image",
    });
  }

  elements.push({ text: strong(message.brand.name), type: "mrkdwn" });

  return { elements, type: "context" };
}

export type SlackLayoutVariant = "message" | "reply";

/**
 * The whole message: "message" for a new message, a direct message or a
 * thread's first message; "reply" for a reply in a channel's thread.
 */
export function buildSlackMessage(
  message: NotificationMessage,
  variant: SlackLayoutVariant = "message",
): SlackMessageContent {
  const reply = variant === "reply";
  const headline = {
    text: {
      text: `${SLACK_EVENT_EMOJI[message.kind]}  ${headlineMarkup(message.headline)}`,
      type: "mrkdwn",
    },
    type: "section",
  };
  const details = detailsLine(message, reply);
  const body: SlackBlock[] = [];

  if (!reply) {
    body.push(headline);
  }

  if (details) {
    body.push({
      elements: [{ text: details, type: "mrkdwn" }],
      type: "context",
    });
  }

  const actions = actionsBlock(message, reply);

  if (actions) {
    body.push(actions);
  }

  const text = escapeSlackText(message.text);

  return {
    attachments:
      body.length > 0
        ? [
            {
              blocks: body,
              color: SLACK_TONE_COLORS[message.tone],
              fallback: text,
            },
          ]
        : undefined,
    blocks: reply ? [headline] : [brandBlock(message)],
    text,
  };
}
