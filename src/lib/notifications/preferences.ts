import { z } from "zod";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  withTransaction,
} from "../db/connection.ts";
import {
  listNotificationEvents,
  notificationEventKinds,
  type NotificationEventKind,
} from "./events.ts";
import { getNotificationChannel } from "./registry.ts";
import type { NotificationPreferenceRecord } from "./targets.ts";

// What a person chose for their own direct messages about the envelopes
// they sent, per channel and event. Only choices that differ from the
// default are worth a row, but a row that matches the default is harmless;
// saving writes what was sent.

export type PreferenceChoice = {
  enabled: boolean;
  event: NotificationEventKind;
};

export const preferenceUpdateSchema = z.object({
  channel: z.string().trim().min(1).max(40),
  preferences: z
    .array(
      z.object({
        enabled: z.boolean(),
        event: z.enum(notificationEventKinds),
      }),
    )
    .max(notificationEventKinds.length),
});

export async function listPreferencesForUsers(
  userIds: string[],
  database: DbExecutor = getDb(),
): Promise<NotificationPreferenceRecord[]> {
  if (userIds.length === 0) {
    return [];
  }

  return queryMany<NotificationPreferenceRecord>(
    database,
    `
      SELECT user_id AS "userId", channel, event, enabled
      FROM notification_preferences
      WHERE user_id = ANY($1)
    `,
    [userIds],
  );
}

/**
 * Every choice a person can make on one channel, with what applies now:
 * theirs where they made one, the default otherwise.
 */
export async function getPreferenceChoices(
  userId: string,
  channel: string,
  database: DbExecutor = getDb(),
): Promise<PreferenceChoice[]> {
  const stored = await listPreferencesForUsers([userId], database);

  return listNotificationEvents().map((definition) => {
    const found = stored.find(
      (row) => row.channel === channel && row.event === definition.kind,
    );

    return {
      enabled: found?.enabled ?? definition.onByDefault,
      event: definition.kind,
    };
  });
}

export async function savePreferenceChoices(
  userId: string,
  body: unknown,
  database: DbPool = getDb(),
): Promise<PreferenceChoice[] | null> {
  const parsed = preferenceUpdateSchema.safeParse(body);

  if (!parsed.success || !getNotificationChannel(parsed.data.channel)) {
    return null;
  }

  const { channel, preferences } = parsed.data;
  const now = Math.floor(Date.now() / 1000);

  await withTransaction(async (tx) => {
    for (const preference of preferences) {
      await tx.query(
        `
          INSERT INTO notification_preferences (
            user_id, channel, event, enabled, updated_at
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (user_id, channel, event) DO UPDATE SET
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
        `,
        [userId, channel, preference.event, preference.enabled, now],
      );
    }
  }, database);

  return getPreferenceChoices(userId, channel, database);
}
