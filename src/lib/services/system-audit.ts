import { createHash, randomUUID } from "node:crypto";

import {
  type DbExecutor,
  getDb,
  queryMany,
  withTransaction,
} from "../db/connection.ts";
import { canonicalJson } from "../utils/canonical-json.ts";

// The install's own audit trail: changes that are not about one envelope,
// such as a setting, a role, an identity check or a signing lock. Part 11
// (11.10(e)) asks for a computer-made, time-stamped record of what was done
// to the records and to who may sign them, which never hides what came
// before. Like each envelope's trail, the rows form one hash chain, so a
// changed, removed or reordered row shows.

export const systemAuditEventTypes = [
  "settings_changed",
  "part11_mode_changed",
  "role_changed",
  "identity_verified",
  "identity_verification_revoked",
  "signing_locked",
  "signing_unlocked",
  "reauthentication_failed",
] as const;

export type SystemAuditEventType = (typeof systemAuditEventTypes)[number];

export type SystemAuditEvent = {
  actorEmail: string | null;
  actorUserId: string | null;
  createdAt: number;
  event: SystemAuditEventType;
  id: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  sequence: number;
  targetUserId: string | null;
  userAgent: string | null;
};

export type RecordSystemAuditEventInput = {
  actorEmail?: string | null;
  actorUserId?: string | null;
  createdAt?: number;
  event: SystemAuditEventType;
  ipAddress?: string | null;
  metadata?: Record<string, unknown> | null;
  targetUserId?: string | null;
  userAgent?: string | null;
};

/** One key for the whole chain: writers take turns. */
const SYSTEM_AUDIT_LOCK_ID = 746108325;

type ChainedFields = Omit<SystemAuditEvent, never>;

export function computeSystemAuditRowHash(
  previousHash: string | null,
  fields: ChainedFields,
): string {
  return createHash("sha256")
    .update(previousHash ?? "")
    .update("\n")
    .update(canonicalJson(fields))
    .digest("hex");
}

function isPool(database: DbExecutor): database is ReturnType<typeof getDb> {
  return "connect" in database && "totalCount" in database;
}

async function insertChained(
  input: RecordSystemAuditEventInput,
  database: DbExecutor,
): Promise<SystemAuditEvent> {
  await database.query("SELECT pg_advisory_xact_lock($1)", [
    SYSTEM_AUDIT_LOCK_ID,
  ]);

  const previous = await database.query<{
    rowHash: string;
    sequence: number;
  }>(
    `
      SELECT sequence, row_hash AS "rowHash"
      FROM system_audit_events
      ORDER BY sequence DESC
      LIMIT 1
    `,
  );
  const previousRow = previous.rows[0];
  const fields: ChainedFields = {
    actorEmail: input.actorEmail ?? null,
    actorUserId: input.actorUserId ?? null,
    createdAt: input.createdAt ?? Math.floor(Date.now() / 1000),
    event: input.event,
    id: randomUUID(),
    ipAddress: input.ipAddress ?? null,
    metadata: input.metadata ?? null,
    sequence: (previousRow?.sequence ?? 0) + 1,
    targetUserId: input.targetUserId ?? null,
    userAgent: input.userAgent ?? null,
  };
  const previousHash = previousRow?.rowHash ?? null;

  await database.query(
    `
      INSERT INTO system_audit_events (
        id, sequence, event, actor_user_id, actor_email, target_user_id,
        ip_address, user_agent, metadata, created_at, prev_hash, row_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    [
      fields.id,
      fields.sequence,
      fields.event,
      fields.actorUserId,
      fields.actorEmail,
      fields.targetUserId,
      fields.ipAddress,
      fields.userAgent,
      fields.metadata,
      fields.createdAt,
      previousHash,
      computeSystemAuditRowHash(previousHash, fields),
    ],
  );

  return fields;
}

/**
 * Adds an event to the install's trail. Given a transaction, the event
 * lands or rolls back with the change it describes.
 */
export async function recordSystemAuditEvent(
  input: RecordSystemAuditEventInput,
  database: DbExecutor = getDb(),
): Promise<SystemAuditEvent> {
  if (isPool(database)) {
    return withTransaction((client) => insertChained(input, client), database);
  }

  return insertChained(input, database);
}

type SystemAuditRow = SystemAuditEvent & {
  prevHash: string | null;
  rowHash: string;
};

const SYSTEM_AUDIT_COLUMNS = `
  id,
  sequence,
  event,
  actor_user_id AS "actorUserId",
  actor_email AS "actorEmail",
  target_user_id AS "targetUserId",
  ip_address AS "ipAddress",
  user_agent AS "userAgent",
  metadata,
  created_at AS "createdAt"
`;

/** The newest events first, a page at a time. */
export async function listSystemAuditEvents(
  {
    before,
    limit = 100,
  }: {
    /** Only events with a lower sequence than this. */
    before?: number | null;
    limit?: number;
  } = {},
  database: DbExecutor = getDb(),
): Promise<SystemAuditEvent[]> {
  return queryMany<SystemAuditEvent>(
    database,
    `
      SELECT ${SYSTEM_AUDIT_COLUMNS}
      FROM system_audit_events
      WHERE ($1::int IS NULL OR sequence < $1)
      ORDER BY sequence DESC
      LIMIT $2
    `,
    [before ?? null, Math.max(1, Math.min(limit, 1000))],
  );
}

/** Every event in a time range, oldest first, for an export. */
export async function listSystemAuditEventsBetween(
  from: number,
  to: number,
  database: DbExecutor = getDb(),
): Promise<SystemAuditEvent[]> {
  return queryMany<SystemAuditEvent>(
    database,
    `
      SELECT ${SYSTEM_AUDIT_COLUMNS}
      FROM system_audit_events
      WHERE created_at >= $1 AND created_at <= $2
      ORDER BY sequence ASC
    `,
    [from, to],
  );
}

export type SystemAuditChainCheck =
  | { events: number; ok: true }
  | { brokenAtSequence: number; events: number; ok: false };

/** Recomputes the whole chain and reports the first row that disagrees. */
export async function verifySystemAuditChain(
  database: DbExecutor = getDb(),
): Promise<SystemAuditChainCheck> {
  const rows = await queryMany<SystemAuditRow>(
    database,
    `
      SELECT ${SYSTEM_AUDIT_COLUMNS},
        prev_hash AS "prevHash",
        row_hash AS "rowHash"
      FROM system_audit_events
      ORDER BY sequence ASC
    `,
  );
  let previousHash: string | null = null;
  let expected = 1;

  for (const row of rows) {
    const { prevHash, rowHash, ...fields } = row;

    if (
      row.sequence !== expected ||
      prevHash !== previousHash ||
      rowHash !== computeSystemAuditRowHash(previousHash, fields)
    ) {
      return { brokenAtSequence: expected, events: rows.length, ok: false };
    }

    previousHash = rowHash;
    expected += 1;
  }

  return { events: rows.length, ok: true };
}
