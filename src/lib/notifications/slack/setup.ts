import type {
  ChannelCheckResult,
  ChannelContext,
  ChannelTarget,
  NotificationChannelSetup,
} from "../channel.ts";
import type { NotificationEventKind } from "../events.ts";
import type { NotificationBrand } from "../message.ts";
import type {
  SlackApiError,
  SlackClient,
  SlackMessageContent,
} from "./client.ts";
import { buildSlackMessage } from "./layout.ts";
import { buildSlackManifest } from "./manifest.ts";
import { buildSampleMessage } from "./preview.ts";

// What Settings, Notifications does with Slack: the app manifest to paste,
// the icon to upload, the bot token's check, and the tests an administrator
// can run (the connection, the list of channels, a test message). The page
// reaches these through the registry, never from here directly.

/** The app icon to upload in Slack; also the picture in the previews. */
export const SLACK_ICON_PATH = "/api/admin/notifications/slack-icon";

// Plain words for what Slack said, from its error code alone.
const SLACK_ERROR_WORDS: Record<string, string> = {
  account_inactive: "The token belongs to an app or user that was deactivated.",
  channel_not_found:
    "Slack has no channel with that ID that the app can see. For a private channel, invite the app first.",
  invalid_auth:
    "Slack did not accept the token. Paste the Bot User OAuth Token again.",
  is_archived: "That channel is archived.",
  missing_scope:
    "The app is missing a permission. Recreate it from the manifest above, or add the scopes listed there, and reinstall it.",
  not_authed: "No token was sent.",
  not_in_channel:
    "The app is not in that channel. In Slack, open the channel and type /invite @ followed by the app's name.",
  not_configured: "Slack is not set up yet.",
  ratelimited: "Slack asked to slow down. Try again in a minute.",
  token_revoked:
    "The token was revoked. Reinstall the app and paste the new token.",
  invalid_response: "Slack sent back something that could not be read.",
  network_error: "Slack could not be reached. Check the network and try again.",
  timeout: "Slack did not answer in time. Try again in a minute.",
  users_not_found:
    "Slack has nobody with your email address. Your Slack account needs the same address as this one.",
};

export function describeSlackError(code: string): string {
  const status = /^http_(\d{3})$/.exec(code);

  if (status) {
    return `Slack could not be reached properly (HTTP ${status[1] ?? ""}).`;
  }

  return SLACK_ERROR_WORDS[code] ?? `Slack answered with the error "${code}".`;
}

function failure(error: SlackApiError): ChannelCheckResult {
  return { message: describeSlackError(error.error), ok: false };
}

const NOT_CONFIGURED: ChannelCheckResult & { ok: false } = {
  message: describeSlackError("not_configured"),
  ok: false,
};

/**
 * A test message: a sample of `kind` as the real ones look, marked as a
 * test, with one button to this site instead of a made-up envelope's.
 */
export function buildSlackTestMessage(
  kind: NotificationEventKind,
  { appUrl, brand }: { appUrl: string | null; brand: NotificationBrand },
): SlackMessageContent {
  const sample = buildSampleMessage(kind, { appUrl, brand });
  const content = buildSlackMessage(
    {
      ...sample,
      actions: appUrl
        ? [
            {
              id: "open",
              label: `Open ${brand.name}`,
              url: `${appUrl.replace(/\/+$/, "")}/dashboard`,
            },
          ]
        : [],
    },
    "message",
  );
  const note =
    "Test message from Settings, Notifications. Nothing happened to a real envelope.";

  return {
    ...content,
    blocks: [
      ...(content.blocks ?? []),
      { elements: [{ text: note, type: "mrkdwn" }], type: "context" },
    ],
    text: `${note} ${content.text}`,
  };
}

export function createSlackSetup({
  client,
  tokenSchema,
}: {
  client: (context: ChannelContext) => SlackClient | null;
  tokenSchema: NotificationChannelSetup["tokenSchema"];
}): NotificationChannelSetup {
  return {
    describeError: describeSlackError,
    iconPath: SLACK_ICON_PATH,

    async listTargets(context) {
      const slack = client(context);

      if (!slack) {
        return NOT_CONFIGURED;
      }

      const targets: ChannelTarget[] = [];
      let cursor: string | null = null;

      // Five pages of 200 are enough to pick from; a larger workspace can
      // paste a channel's ID.
      for (let page = 0; page < 5; page += 1) {
        const result = await slack.listChannels(cursor);

        if (!result.ok) {
          return { message: describeSlackError(result.error), ok: false };
        }

        targets.push(...result.channels);
        cursor = result.nextCursor;

        if (!cursor) {
          break;
        }
      }

      targets.sort((a, b) => a.name.localeCompare(b.name));

      return { ok: true, targets };
    },

    manifest(input) {
      return JSON.stringify(buildSlackManifest(input), null, 2);
    },

    async sendTest(to, sample, context) {
      const slack = client(context);

      if (!slack) {
        return NOT_CONFIGURED;
      }

      let destination: string;

      if ("email" in to) {
        const user = await slack.lookupUserByEmail(to.email);

        if (!user.ok) {
          return failure(user);
        }

        destination = user.userId;
      } else {
        destination = to.destination;
      }

      const result = await slack.postMessage({
        ...buildSlackTestMessage(sample.kind, sample),
        channel: destination,
      });

      return result.ok
        ? { message: "Sent. Look for it in Slack.", ok: true }
        : failure(result);
    },

    /** "Test connection": asks Slack who the token belongs to. */
    async testConnection(context) {
      const slack = client(context);

      if (!slack) {
        return NOT_CONFIGURED;
      }

      const result = await slack.authTest();

      if (!result.ok) {
        return failure(result);
      }

      return {
        message: `Connected to the ${result.team ?? "Slack"} workspace.`,
        ok: true,
      };
    },

    tokenSchema,
  };
}
