import { type DbExecutor, getDb, queryOne } from "../db/connection.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../services/seal-identity.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import { isMissingSchemaError } from "../settings.ts";
import { readEnv, type EnvSource } from "../utils/env.ts";

// What an administrator set up for notifications in Settings: one row in
// notification_settings. The Slack bot token is stored encrypted with a key
// derived from the auth secret, the same way as the seal's private key
// (services/seal-identity.ts), and is never sent back to the browser. If
// that secret changes, the stored token can no longer be read and Slack
// counts as not set up until a token is pasted again. SLACK_BOT_TOKEN, when
// set, wins over the stored token (slack/channel.ts).

const TOKEN_CONTEXT = "signudoc/notifications/slack-token/v1";

export type StoredNotificationSettings = {
  /** Direct messages to people; channel rules post either way. */
  directMessages: boolean;
  /** Null: the default (settings.ts). */
  expiringDays: number | null;
  slackBotToken: string | null;
  stuckDays: number | null;
};

export const EMPTY_NOTIFICATION_SETTINGS: StoredNotificationSettings = {
  directMessages: true,
  expiringDays: null,
  slackBotToken: null,
  stuckDays: null,
};

/** Who changed the settings, for the install's audit trail. */
export type NotificationSettingsActor = {
  email: string;
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type NotificationSettingsUpdate = {
  directMessages?: boolean;
  expiringDays?: number;
  /** A new token, or null to remove the stored one. */
  slackBotToken?: string | null;
  stuckDays?: number;
};

type SettingsRow = {
  directMessages: boolean;
  expiringDays: number | null;
  slackBotTokenEncrypted: string | null;
  stuckDays: number | null;
};

/** How long a peek trusts the settings last read in this instance. */
const PEEK_SECONDS = 60;

declare global {
  var __signudocNotificationSettings:
    { readAt: number; settings: StoredNotificationSettings } | undefined;
}

function remember(settings: StoredNotificationSettings) {
  globalThis.__signudocNotificationSettings = {
    readAt: Date.now(),
    settings,
  };
}

function decryptToken(value: string | null, env: EnvSource): string | null {
  if (!value) {
    return null;
  }

  try {
    return decryptPrivateKey(value, secretKeyFor(TOKEN_CONTEXT, env));
  } catch {
    return null;
  }
}

function fromRow(
  row: SettingsRow | null,
  env: EnvSource,
): StoredNotificationSettings {
  if (!row) {
    return EMPTY_NOTIFICATION_SETTINGS;
  }

  return {
    directMessages: row.directMessages,
    expiringDays: row.expiringDays,
    slackBotToken: decryptToken(row.slackBotTokenEncrypted, env),
    stuckDays: row.stuckDays,
  };
}

const SELECT_SETTINGS = `
  SELECT
    slack_bot_token_encrypted AS "slackBotTokenEncrypted",
    direct_messages AS "directMessages",
    expiring_days AS "expiringDays",
    stuck_days AS "stuckDays"
  FROM notification_settings
  WHERE id
`;

/**
 * The settings last read in this server instance, without asking the
 * database, or null when none were read in the last minute. For the
 * after-request kick (kick.ts), which only wants to know whether a run
 * could send anything.
 */
export function peekNotificationSettings(): StoredNotificationSettings | null {
  const cached = globalThis.__signudocNotificationSettings;

  return cached && Date.now() - cached.readAt < PEEK_SECONDS * 1000
    ? cached.settings
    : null;
}

export async function readNotificationSettings(
  database: DbExecutor = getDb(),
  env: EnvSource = process.env,
): Promise<StoredNotificationSettings> {
  let row: SettingsRow | null;

  try {
    row = await queryOne<SettingsRow>(database, SELECT_SETTINGS);
  } catch (error) {
    // A database without this version's tables has nothing set up.
    if (isMissingSchemaError(error)) {
      return EMPTY_NOTIFICATION_SETTINGS;
    }

    throw error;
  }

  const settings = fromRow(row, env);

  remember(settings);

  return settings;
}

/**
 * Changes the settings inside the caller's transaction, under the row's
 * lock, and records what changed in the install's audit trail (never the
 * token itself). A new or removed token also forgets the people and
 * messages remembered for Slack: they belong to the workspace the old
 * token was for.
 */
export async function updateNotificationSettings(
  tx: DbExecutor,
  update: NotificationSettingsUpdate,
  actor: NotificationSettingsActor,
  env: EnvSource = process.env,
): Promise<StoredNotificationSettings> {
  const now = Math.floor(Date.now() / 1000);

  await tx.query(
    `
      INSERT INTO notification_settings (id, updated_at) VALUES (true, $1)
      ON CONFLICT (id) DO NOTHING
    `,
    [now],
  );

  const before = fromRow(
    await queryOne<SettingsRow>(tx, `${SELECT_SETTINGS} FOR UPDATE`),
    env,
  );
  const after: StoredNotificationSettings = {
    directMessages: update.directMessages ?? before.directMessages,
    expiringDays: update.expiringDays ?? before.expiringDays,
    slackBotToken:
      update.slackBotToken === undefined
        ? before.slackBotToken
        : update.slackBotToken,
    stuckDays: update.stuckDays ?? before.stuckDays,
  };
  const tokenChanged = after.slackBotToken !== before.slackBotToken;
  const changes: Record<string, unknown> = {};

  for (const key of ["directMessages", "expiringDays", "stuckDays"] as const) {
    if (after[key] !== before[key]) {
      changes[key] = { from: before[key], to: after[key] };
    }
  }

  if (tokenChanged) {
    changes.slackBotToken = after.slackBotToken === null ? "removed" : "saved";
  }

  if (Object.keys(changes).length === 0) {
    return before;
  }

  await tx.query(
    `
      UPDATE notification_settings SET
        slack_bot_token_encrypted = $1,
        direct_messages = $2,
        expiring_days = $3,
        stuck_days = $4,
        updated_at = $5
      WHERE id
    `,
    [
      after.slackBotToken === null
        ? null
        : encryptPrivateKey(
            after.slackBotToken,
            secretKeyFor(TOKEN_CONTEXT, env),
          ),
      after.directMessages,
      after.expiringDays,
      after.stuckDays,
      now,
    ],
  );

  if (tokenChanged) {
    await tx.query(
      `DELETE FROM notification_identities WHERE channel = 'slack'`,
    );
    await tx.query(`DELETE FROM notification_threads WHERE channel = 'slack'`);
  }

  await recordSystemAuditEvent(
    {
      actorEmail: actor.email,
      actorUserId: actor.id,
      event: "settings_changed",
      ipAddress: actor.ipAddress ?? null,
      metadata: { area: "notifications", changes },
      userAgent: actor.userAgent ?? null,
    },
    tx,
  );

  return after;
}

// The job's thresholds: "Deadline coming up" and "No activity".

export const DEFAULT_EXPIRING_DAYS = 3;
export const DEFAULT_STUCK_DAYS = 7;
export const MAX_THRESHOLD_DAYS = 60;

export type NotificationThresholds = {
  expiringDays: number;
  expiringFromEnv: boolean;
  stuckDays: number;
  stuckFromEnv: boolean;
};

function readDays(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,3}$/.test(value.trim())) {
    return null;
  }

  return Math.min(Number.parseInt(value.trim(), 10), MAX_THRESHOLD_DAYS);
}

/**
 * How many days before a deadline "expiring soon" is, and how many days
 * without activity count as stuck. 0 turns either off. The environment
 * (NOTIFICATION_EXPIRING_DAYS, NOTIFICATION_STUCK_DAYS) wins.
 */
export function readNotificationThresholds(
  env: EnvSource,
  stored: StoredNotificationSettings,
): NotificationThresholds {
  const expiringEnv = readDays(readEnv(env, "NOTIFICATION_EXPIRING_DAYS"));
  const stuckEnv = readDays(readEnv(env, "NOTIFICATION_STUCK_DAYS"));

  return {
    expiringDays: expiringEnv ?? stored.expiringDays ?? DEFAULT_EXPIRING_DAYS,
    expiringFromEnv: expiringEnv !== null,
    stuckDays: stuckEnv ?? stored.stuckDays ?? DEFAULT_STUCK_DAYS,
    stuckFromEnv: stuckEnv !== null,
  };
}
