import { z } from "zod";

import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
  type DbPool,
  withTransaction,
} from "../db/connection.ts";
import { getBranding } from "../settings.ts";
import { resolveAppUrl, type EnvSource } from "../utils/env.ts";
import type {
  ChannelCheckResult,
  ChannelContext,
  ChannelPreview,
  ChannelTarget,
  NotificationChannelPackage,
} from "./channel.ts";
import {
  listNotificationEvents,
  notificationKindFor,
  type NotificationEventDefinition,
  type NotificationEventKind,
} from "./events.ts";
import type { NotificationBrand } from "./message.ts";
import { getPreferenceChoices, type PreferenceChoice } from "./preferences.ts";
import { getNotificationChannel, getNotificationChannels } from "./registry.ts";
import { listNotificationRules, type NotificationRule } from "./rules.ts";
import {
  MAX_THRESHOLD_DAYS,
  readNotificationSettings,
  readNotificationThresholds,
  updateNotificationSettings,
  type NotificationSettingsActor,
  type NotificationSettingsUpdate,
  type NotificationThresholds,
} from "./store.ts";

// Settings, Notifications: what the administrator sets up (the Slack app,
// direct messages, the job's thresholds and the rules) and the checks they
// can run, and what each person chooses for their own direct messages.
// Every chat tool is reached through the registry by its id; what is
// particular to one lives in its own folder.

function siteUrl(env: EnvSource): string | null {
  try {
    return resolveAppUrl(env)?.replace(/\/+$/, "") ?? null;
  } catch {
    return null;
  }
}

export type DeliveryStats = {
  /** Held signatures left out because a newer message covered them. */
  combinedLastWeek: number;
  failedLastWeek: number;
  pending: number;
  recentProblems: {
    at: number;
    error: string;
    /** The kind of notification, or the queued event's name. */
    event: string;
    status: string;
    targetKind: string;
  }[];
  sentLastWeek: number;
  skippedLastWeek: number;
};

async function readDeliveryStats(database: DbExecutor): Promise<DeliveryStats> {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const counts = await queryOne<{
    combined: number;
    failed: number;
    pending: number;
    sent: number;
    skipped: number;
  }>(
    database,
    `
      SELECT
        count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS pending,
        count(*) FILTER (WHERE status = 'sent' AND updated_at >= $1)::int AS sent,
        count(*) FILTER (WHERE status = 'failed' AND updated_at >= $1)::int AS failed,
        count(*) FILTER (
          WHERE status = 'skipped' AND updated_at >= $1
            AND last_error IS DISTINCT FROM 'superseded'
        )::int AS skipped,
        count(*) FILTER (
          WHERE status = 'skipped' AND updated_at >= $1
            AND last_error = 'superseded'
        )::int AS combined
      FROM notification_deliveries
    `,
    [since],
  );
  const problems = await queryMany<
    Omit<DeliveryStats["recentProblems"][number], "event"> & {
      event: string;
      source: "audit" | "job";
    }
  >(
    database,
    `
      SELECT d.updated_at AS at, d.last_error AS error, e.source, e.event,
        d.status, d.target_kind AS "targetKind"
      FROM notification_deliveries d
      JOIN notification_events e ON e.id = d.event_id
      WHERE d.last_error IS NOT NULL AND d.updated_at >= $1
        AND d.status <> 'sent'
        AND d.last_error NOT IN ('superseded', 'no_longer_wanted', 'outdated')
      ORDER BY d.updated_at DESC
      LIMIT 5
    `,
    [since],
  );

  return {
    combinedLastWeek: counts?.combined ?? 0,
    failedLastWeek: counts?.failed ?? 0,
    pending: counts?.pending ?? 0,
    recentProblems: problems.map(({ source, ...problem }) => ({
      ...problem,
      event: notificationKindFor(source, problem.event) ?? problem.event,
    })),
    sentLastWeek: counts?.sent ?? 0,
    skippedLastWeek: counts?.skipped ?? 0,
  };
}

export type NotificationsAdminView = {
  deliveries: DeliveryStats;
  events: NotificationEventDefinition[];
  rules: NotificationRule[];
  siteUrl: string | null;
  slack: {
    configured: boolean;
    directMessages: boolean;
    /** The app's name in Slack: the organization's, or SignuDoc. */
    appName: string;
    /** The app's icon on this site, to download and to show in previews. */
    iconPath: string;
    /** The app manifest to paste into Slack, as formatted JSON. */
    manifest: string;
    /** A sample of each kind of message, as Slack would show it. */
    previews: ChannelPreview[];
    source: "env" | "settings" | null;
  };
  thresholds: NotificationThresholds;
};

/**
 * The app's name and logo for messages. `absoluteLogo`: the logo
 * as an https address Slack can fetch, else none; otherwise the path on
 * this site, for a preview in the browser.
 */
async function messageBrand(
  env: EnvSource,
  absoluteLogo: boolean,
): Promise<NotificationBrand & { brandColor: string | null }> {
  const branding = await getBranding(env);
  const base = siteUrl(env);
  let logoUrl = branding.logoUrl;

  if (logoUrl && absoluteLogo) {
    logoUrl = base?.startsWith("https://") ? `${base}${logoUrl}` : null;
  }

  return {
    brandColor: branding.brandColor,
    logoUrl,
    name: branding.productName,
  };
}

/** A channel this install has, by id. */
function requireChannel(id: string): NotificationChannelPackage {
  const channel = getNotificationChannel(id);

  if (!channel) {
    throw new Error(`No notification channel "${id}".`);
  }

  return channel;
}

export async function getNotificationsAdminView(
  env: EnvSource = process.env,
  database: DbExecutor = getDb(),
): Promise<NotificationsAdminView> {
  const stored = await readNotificationSettings(database, env);
  const brand = await messageBrand(env, false);
  const slack = requireChannel("slack");
  const status = slack.status({ env, stored });
  const url = siteUrl(env);
  const [rules, deliveries] = await Promise.all([
    listNotificationRules(database),
    readDeliveryStats(database),
  ]);

  return {
    deliveries,
    events: listNotificationEvents(),
    rules,
    siteUrl: url,
    slack: {
      appName: brand.name,
      configured: status.configured,
      directMessages: status.directMessages,
      iconPath: slack.setup.iconPath,
      manifest:
        slack.setup.manifest({
          appName: brand.name,
          brandColor: brand.brandColor,
          siteUrl: url,
        }) ?? "",
      previews: slack.previews({
        // Without the site's address there would be no buttons to show.
        appUrl: url ?? "https://sign.example.com",
        brand: { logoUrl: brand.logoUrl, name: brand.name },
      }),
      source: status.source,
    },
    thresholds: readNotificationThresholds(env, stored),
  };
}

const thresholdSchema = z.number().int().min(0).max(MAX_THRESHOLD_DAYS);

const saveSchema = z.object({
  directMessages: z.boolean().optional(),
  expiringDays: thresholdSchema.optional(),
  removeSlackBotToken: z.boolean().optional(),
  slackBotToken: z.string().max(400).optional(),
  stuckDays: thresholdSchema.optional(),
});

export class NotificationSaveError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "NotificationSaveError";
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Saves the administrator's changes and records them in the install's
 * audit trail, in one transaction.
 */
export async function saveNotificationSettings(
  body: unknown,
  actor: NotificationSettingsActor,
  env: EnvSource = process.env,
  database: DbPool = getDb(),
): Promise<NotificationsAdminView> {
  const parsed = saveSchema.safeParse(body);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "form");

      fieldErrors[field] ??= field.endsWith("Days")
        ? "Use a whole number of days from 0 to 60."
        : "Check this value.";
    }

    throw new NotificationSaveError(
      "Check the highlighted fields.",
      fieldErrors,
    );
  }

  const input = parsed.data;
  const update: NotificationSettingsUpdate = {
    directMessages: input.directMessages,
    expiringDays: input.expiringDays,
    stuckDays: input.stuckDays,
  };

  if (input.slackBotToken !== undefined && input.slackBotToken.trim()) {
    const token = requireChannel("slack").setup.tokenSchema.safeParse(
      input.slackBotToken,
    );

    if (!token.success) {
      throw new NotificationSaveError("Check the bot token.", {
        slackBotToken: token.error.issues[0]?.message ?? "Check the token.",
      });
    }

    update.slackBotToken = token.data;
  } else if (input.removeSlackBotToken) {
    update.slackBotToken = null;
  }

  await withTransaction(
    (tx) => updateNotificationSettings(tx, update, actor, env),
    database,
  );

  return getNotificationsAdminView(env, database);
}

async function channelContext(env: EnvSource): Promise<ChannelContext> {
  return { env, stored: await readNotificationSettings(getDb(), env) };
}

/** "Test connection": asks the chat tool whose credentials these are. */
export async function testChannelConnection(
  channelId: string,
  env: EnvSource = process.env,
): Promise<ChannelCheckResult> {
  return requireChannel(channelId).setup.testConnection(
    await channelContext(env),
  );
}

/** The places a rule can post to, for picking one. */
export async function listChannelTargets(
  channelId: string,
  env: EnvSource = process.env,
): Promise<
  { ok: true; targets: ChannelTarget[] } | (ChannelCheckResult & { ok: false })
> {
  return requireChannel(channelId).setup.listTargets(await channelContext(env));
}

/**
 * Sends a test message to a place, or to the person asking (found by
 * their email address), so the setup can be seen to work.
 */
export async function sendChannelTestMessage(
  channelId: string,
  to: { destination: string } | { email: string },
  env: EnvSource = process.env,
  kind: NotificationEventKind = "envelope_completed",
): Promise<ChannelCheckResult> {
  const brand = await messageBrand(env, true);

  return requireChannel(channelId).setup.sendTest(
    to,
    {
      appUrl: siteUrl(env),
      brand: { logoUrl: brand.logoUrl, name: brand.name },
      kind,
    },
    await channelContext(env),
  );
}

/**
 * A rule's "Send test": a sample of the first event the rule names, posted
 * to its channel. Null when there is no such rule.
 */
export async function sendRuleTest(
  ruleId: string,
  env: EnvSource = process.env,
  database: DbExecutor = getDb(),
): Promise<ChannelCheckResult | null> {
  const rule = (await listNotificationRules(database)).find(
    (item) => item.id === ruleId,
  );

  if (!rule) {
    return null;
  }

  if (!getNotificationChannel(rule.channel)) {
    return { message: "That channel cannot be used yet.", ok: false };
  }

  const result = await sendChannelTestMessage(
    rule.channel,
    { destination: rule.destination },
    env,
    rule.events[0] ?? "envelope_completed",
  );
  const where = rule.destinationName
    ? `#${rule.destinationName}`
    : rule.destination;

  return result.ok
    ? { message: `Sent a test message to ${where}.`, ok: true }
    : result;
}

export type NotificationPreferencesView = {
  channels: {
    /** Direct messages can reach this person on this channel now. */
    available: boolean;
    choices: PreferenceChoice[];
    id: string;
    name: string;
  }[];
  events: NotificationEventDefinition[];
};

export async function getNotificationPreferencesView(
  userId: string,
  env: EnvSource = process.env,
  database: DbExecutor = getDb(),
): Promise<NotificationPreferencesView> {
  const stored = await readNotificationSettings(database, env);

  return {
    channels: await Promise.all(
      getNotificationChannels().map(async (channel) => {
        const status = channel.status({ env, stored });

        return {
          available: status.configured && status.directMessages,
          choices: await getPreferenceChoices(userId, channel.id, database),
          id: channel.id,
          name: channel.name,
        };
      }),
    ),
    events: listNotificationEvents(),
  };
}
