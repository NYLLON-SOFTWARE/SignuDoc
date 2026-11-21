import {
  contrastRatio,
  DEFAULT_BRAND_COLOR,
  normalizeBrandColor,
} from "../../brand-color.ts";

// The Slack app manifest shown on the setup page, for "Create New App, From
// a manifest" at https://api.slack.com/apps. It asks for as little as
// notifications need:
//
// * chat:write: post the messages, to people and to channels the app has
//   been invited to, and edit its own messages (a thread's first message,
//   a direct message that shows progress). Without chat:write.public it
//   cannot post anywhere it was not invited, which keeps a rule from
//   reaching a channel nobody added it to.
// * users:read and users:read.email: find a person's Slack account from
//   their email address (users.lookupByEmail), for direct messages. Slack
//   only grants users:read.email together with users:read.
// * channels:read: list public channels to pick from when making a rule.
//   A private channel is pasted by its ID instead, so groups:read is not
//   asked for.
//
// The app has no events, slash commands or interactivity: it only sends.
// Its buttons are plain links. The messages tab of its App Home is on,
// read-only, because that is where Slack shows the app's direct messages.
//
// Slack does not take an icon in a manifest. The setup page offers one to
// download (/api/admin/notifications/slack-icon) and says where to upload it.

export const SLACK_BOT_SCOPES = [
  "chat:write",
  "users:read",
  "users:read.email",
  "channels:read",
] as const;

/** Slack's limits for a manifest's display information. */
const MAX_NAME = 35;
const MAX_DESCRIPTION = 140;
const MAX_LONG_DESCRIPTION = 4000;

/**
 * The colour behind the app's name and icon in Slack, which shows the name
 * in white: the organization's colour when white text is readable on it,
 * otherwise SignuDoc's own.
 */
export function slackBackgroundColor(brandColor: string | null): string {
  const color = normalizeBrandColor(brandColor);

  return color && contrastRatio(color, "#ffffff") >= 4.5
    ? color
    : DEFAULT_BRAND_COLOR;
}

export function buildSlackManifest({
  appName,
  brandColor = null,
  siteUrl,
}: {
  appName: string;
  brandColor?: string | null;
  siteUrl: string | null;
}): Record<string, unknown> {
  const name = appName.trim().slice(0, MAX_NAME).trim() || "SignuDoc";
  let host: string | null = null;

  try {
    host = siteUrl ? new URL(siteUrl).host : null;
  } catch {
    host = null;
  }

  const description = (
    host
      ? `Updates on documents sent for signature on ${host}.`
      : "Updates on documents sent for signature."
  ).slice(0, MAX_DESCRIPTION);
  const longDescription = [
    `${name} tells you in Slack when something happens to a document you sent for signature${host ? ` on ${host}` : ""}.`,
    "Each envelope gets one message per channel: the first post starts a thread, later events reply in it, and the first post always shows where things stand, such as 2 of 3 signed.",
    "In your direct messages, progress updates one message in place. A new message only arrives when something needs you: the envelope was completed or declined, its deadline is close, it has gone quiet, or it expired.",
    "Messages name the document and the people involved and link back to it. They never carry the document itself, a field's value, or a reason someone gave for declining.",
    "The app only posts. It cannot read your messages, and it only posts in channels it was invited to.",
  ]
    .join("\n\n")
    .slice(0, MAX_LONG_DESCRIPTION);

  return {
    display_information: {
      background_color: slackBackgroundColor(brandColor),
      description,
      long_description: longDescription,
      name,
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: true,
      },
      bot_user: {
        always_online: true,
        display_name: name,
      },
    },
    oauth_config: {
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
