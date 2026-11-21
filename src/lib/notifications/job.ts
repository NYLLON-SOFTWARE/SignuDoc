import { type DbPool, getDb } from "../db/connection.ts";
import { getBranding } from "../settings.ts";
import { resolveAppUrl, type EnvSource } from "../utils/env.ts";
import type { NotificationChannel } from "./channel.ts";
import { queueConditionEvents, type ConditionSummary } from "./conditions.ts";
import {
  DEFAULT_NOTIFICATION_BRAND,
  type NotificationBrand,
} from "./message.ts";
import {
  channelAvailability,
  deliverDueDeliveries,
  discardQueuedEvents,
  expandQueuedEvents,
  forgetOtherAccounts,
  nextDeliveryDueAt,
  purgeOldNotifications,
  type DeliverySummary,
  type OutboxDeps,
} from "./outbox.ts";
import { getNotificationChannels } from "./registry.ts";
import {
  readNotificationSettings,
  readNotificationThresholds,
} from "./store.ts";

// One run of notifications: notice what the audit trail does not record
// (deadlines coming up, idle envelopes), turn queued events into
// deliveries, send what is due, and clear out what is old.
//
// It runs from /api/internal/notifications (a scheduler, Vercel's cron
// once a day) and, without noticing anything new, right after any request
// that recorded an audit event (kick.ts), so most messages go out within
// seconds. With no channel set up it only marks queued events done (and,
// when scheduled, clears out old ones).

const EXPAND_BATCH = 100;
const MAX_EXPAND_ROUNDS = 20;
/** How far ahead a run looks for a delivery worth waiting for (kick.ts). */
export const NEXT_DUE_WINDOW_SECONDS = 90;

export type NotificationJobSummary =
  | { discarded: number; purged: number; status: "not_configured" }
  | {
      conditions: ConditionSummary | null;
      delivered: DeliverySummary;
      deliveriesCreated: number;
      eventsProcessed: number;
      /** The soonest a waiting delivery is due in the next minute and a half. */
      nextDueAt: number | null;
      purged: number;
      status: "ran";
      /** Work was left: out of time, or more events queued than one run takes. */
      stoppedEarly: boolean;
    };

function safeAppUrl(env: EnvSource): string | null {
  try {
    return resolveAppUrl(env) ?? null;
  } catch {
    return null;
  }
}

/**
 * The organization's name and logo, for the top of every message. The logo
 * goes only to an https site: Slack fetches it from there.
 */
async function notificationBrand(
  env: EnvSource,
  appUrl: string | null,
): Promise<NotificationBrand> {
  try {
    const branding = await getBranding(env);
    const base = appUrl?.replace(/\/+$/, "") ?? null;

    return {
      logoUrl:
        branding.logoUrl && base?.startsWith("https://")
          ? `${base}${branding.logoUrl}`
          : null,
      name: branding.organizationName ?? branding.productName,
    };
  } catch {
    return DEFAULT_NOTIFICATION_BRAND;
  }
}

export async function runNotificationJob({
  channels = getNotificationChannels(),
  database = getDb(),
  deadline,
  detectConditions = true,
  env = process.env,
  now = () => Math.floor(Date.now() / 1000),
}: {
  channels?: NotificationChannel[];
  database?: DbPool;
  /** Milliseconds since the epoch, after which nothing new is started. */
  deadline: number;
  detectConditions?: boolean;
  env?: EnvSource;
  now?: () => number;
}): Promise<NotificationJobSummary> {
  const stored = await readNotificationSettings(database, env);
  const context = { env, stored };
  const configured = channelAvailability(channels, context).some(
    (channel) => channel.configured,
  );

  if (!configured) {
    // Events are queued whatever is set up, so the scheduled run still
    // clears out the old ones.
    return {
      discarded: await discardQueuedEvents(database, now()),
      purged: detectConditions
        ? await purgeOldNotifications(database, now())
        : 0,
      status: "not_configured",
    };
  }

  await forgetOtherAccounts(database, channels, context, now());

  const outOfTime = () => Date.now() >= deadline;
  const appUrl = safeAppUrl(env);
  const deps: OutboxDeps = {
    appUrl,
    brand: await notificationBrand(env, appUrl),
    channels,
    context,
    now,
  };
  let conditions: ConditionSummary | null = null;

  if (detectConditions) {
    conditions = await queueConditionEvents(database, {
      ...readNotificationThresholds(env, stored),
      now: now(),
    });
  }

  let eventsProcessed = 0;
  let deliveriesCreated = 0;
  // Whether the last batch was full, so more may be queued behind it.
  let moreQueued = false;

  for (let round = 0; round < MAX_EXPAND_ROUNDS && !outOfTime(); round += 1) {
    const expanded = await expandQueuedEvents(database, deps, {
      limit: EXPAND_BATCH,
    });

    eventsProcessed += expanded.events;
    deliveriesCreated += expanded.deliveries;
    moreQueued = expanded.events >= EXPAND_BATCH;

    if (!moreQueued) {
      break;
    }
  }

  const delivered = await deliverDueDeliveries(database, deps, { outOfTime });
  const purged = detectConditions
    ? await purgeOldNotifications(database, now())
    : 0;

  return {
    conditions,
    delivered,
    deliveriesCreated,
    eventsProcessed,
    nextDueAt: await nextDeliveryDueAt(
      database,
      now(),
      NEXT_DUE_WINDOW_SECONDS,
    ),
    purged,
    status: "ran",
    // Out of time, or with events still queued after the most one run
    // expands: either way there is more to do, and the caller goes again.
    stoppedEarly: outOfTime() || moreQueued,
  };
}
