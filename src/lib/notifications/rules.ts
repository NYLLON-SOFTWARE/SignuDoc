import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "../db/connection.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import {
  notificationEventKinds,
  type NotificationEventKind,
} from "./events.ts";
import { getNotificationChannel } from "./registry.ts";
import type { NotificationSettingsActor } from "./store.ts";
import type { NotificationRuleRecord } from "./targets.ts";

// An administrator's rules: "these events go to this channel". Each change
// is recorded in the install's audit trail in the same transaction, as a
// change of settings.

export const MAX_NOTIFICATION_RULES = 100;

export class NotificationSettingsError extends Error {
  readonly fieldErrors: Record<string, string>;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode = 400,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "NotificationSettingsError";
    this.fieldErrors = fieldErrors;
    this.statusCode = statusCode;
  }
}

export type NotificationRule = NotificationRuleRecord & {
  destinationName: string | null;
  events: NotificationEventKind[];
};

const ruleInputSchema = z.object({
  channel: z.string().trim().min(1).max(40),
  destination: z.string().trim().min(1).max(200),
  destinationName: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((value) => (value ? value.replace(/^#/, "") : null)),
  enabled: z.boolean().optional(),
  events: z
    .array(z.enum(notificationEventKinds))
    .min(1, "Choose at least one event.")
    .max(notificationEventKinds.length),
});

export type NotificationRuleInput = z.input<typeof ruleInputSchema>;

type RuleRow = {
  channel: string;
  destination: string;
  destinationName: string | null;
  enabled: boolean;
  events: string[];
  id: string;
};

function toRule(row: RuleRow): NotificationRule {
  return {
    ...row,
    events: row.events.filter((event): event is NotificationEventKind =>
      (notificationEventKinds as readonly string[]).includes(event),
    ),
  };
}

export async function listNotificationRules(
  database: DbExecutor = getDb(),
): Promise<NotificationRule[]> {
  const rows = await queryMany<RuleRow>(
    database,
    `
      SELECT
        r.id,
        r.channel,
        r.events,
        r.destination,
        r.destination_name AS "destinationName",
        r.enabled
      FROM notification_rules r
      ORDER BY r.created_at ASC, r.id ASC
    `,
  );

  return rows.map(toRule);
}

function parseRuleInput(body: unknown) {
  const parsed = ruleInputSchema.safeParse(body);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "rule");

      fieldErrors[field] ??= issue.message;
    }

    throw new NotificationSettingsError("Check the rule.", 400, fieldErrors);
  }

  const input = parsed.data;
  const channel = getNotificationChannel(input.channel);

  if (!channel) {
    throw new NotificationSettingsError(
      "That channel cannot be used yet.",
      400,
      {
        channel: "That channel cannot be used yet.",
      },
    );
  }

  const destination = channel.destinationSchema.safeParse(input.destination);

  if (!destination.success) {
    throw new NotificationSettingsError("Check the rule.", 400, {
      destination:
        destination.error.issues[0]?.message ?? "Check the destination.",
    });
  }

  return {
    channel: channel.id,
    destination: destination.data,
    destinationName: input.destinationName,
    // Left as given: a create defaults to on, an update keeps what it had.
    enabled: input.enabled,
    events: [...new Set(input.events)],
  };
}

async function recordRuleChange(
  database: DbExecutor,
  actor: NotificationSettingsActor,
  change: Record<string, unknown>,
) {
  await recordSystemAuditEvent(
    {
      actorEmail: actor.email,
      actorUserId: actor.id,
      event: "settings_changed",
      ipAddress: actor.ipAddress ?? null,
      metadata: { area: "notification_rules", ...change },
      userAgent: actor.userAgent ?? null,
    },
    database,
  );
}

export async function createNotificationRule(
  actor: NotificationSettingsActor,
  body: unknown,
  database: DbPool = getDb(),
): Promise<NotificationRule[]> {
  const input = parseRuleInput(body);

  await withTransaction(async (tx) => {
    const count = await queryOne<{ count: number }>(
      tx,
      `SELECT count(*)::int AS count FROM notification_rules`,
    );

    if ((count?.count ?? 0) >= MAX_NOTIFICATION_RULES) {
      throw new NotificationSettingsError(
        `An install can have up to ${String(MAX_NOTIFICATION_RULES)} rules.`,
      );
    }

    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const enabled = input.enabled ?? true;

    await tx.query(
      `
        INSERT INTO notification_rules (
          id, channel, events, destination, destination_name, enabled,
          created_at, updated_at, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
      `,
      [
        id,
        input.channel,
        input.events,
        input.destination,
        input.destinationName,
        enabled,
        now,
        actor.id,
      ],
    );
    await recordRuleChange(tx, actor, {
      created: { id, ...input, enabled },
    });
  }, database);

  return listNotificationRules(database);
}

export async function updateNotificationRule(
  actor: NotificationSettingsActor,
  id: string,
  body: unknown,
  database: DbPool = getDb(),
): Promise<NotificationRule[]> {
  const input = parseRuleInput(body);

  await withTransaction(async (tx) => {
    const before = await queryOne<RuleRow>(
      tx,
      `
        SELECT id, channel, events, destination,
          destination_name AS "destinationName", enabled
        FROM notification_rules WHERE id = $1 FOR UPDATE
      `,
      [id],
    );

    if (!before) {
      throw new NotificationSettingsError("That rule no longer exists.", 404);
    }

    const enabled = input.enabled ?? before.enabled;

    await tx.query(
      `
        UPDATE notification_rules SET
          channel = $2, events = $3, destination = $4,
          destination_name = $5, enabled = $6, updated_at = $7
        WHERE id = $1
      `,
      [
        id,
        input.channel,
        input.events,
        input.destination,
        input.destinationName,
        enabled,
        Math.floor(Date.now() / 1000),
      ],
    );

    await recordRuleChange(tx, actor, {
      updated: {
        from: {
          channel: before.channel,
          destination: before.destination,
          destinationName: before.destinationName,
          enabled: before.enabled,
          events: before.events,
        },
        id,
        to: { ...input, enabled },
      },
    });
  }, database);

  return listNotificationRules(database);
}

export async function deleteNotificationRule(
  actor: NotificationSettingsActor,
  id: string,
  database: DbPool = getDb(),
): Promise<NotificationRule[]> {
  await withTransaction(async (tx) => {
    const deleted = await tx.query(
      `DELETE FROM notification_rules WHERE id = $1`,
      [id],
    );

    if (deleted.rowCount !== 1) {
      throw new NotificationSettingsError("That rule no longer exists.", 404);
    }

    await recordRuleChange(tx, actor, { deleted: { id } });
  }, database);

  return listNotificationRules(database);
}
