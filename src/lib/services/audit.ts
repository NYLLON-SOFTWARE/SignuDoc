import { createHash, randomUUID } from "node:crypto";

import {
  auditEventRecordSchema,
  type AuditEventRecord,
} from "../schemas/envelope.ts";
import {
  type DbExecutor,
  getDb,
  queryMany,
  withTransaction,
} from "../db/connection.ts";
import { canonicalJson } from "../utils/canonical-json.ts";

export type AuditEventMetadata = Record<string, unknown> | null;

export type RecordAuditEventInput = {
  /** Given when the event was already shown on a certificate under this id. */
  id?: string;
  envelopeId: string;
  event: AuditEventRecord["event"];
  actorType: AuditEventRecord["actorType"];
  actorEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: AuditEventMetadata;
  createdAt?: number;
};

type AuditEventRow = {
  actorEmail: string | null;
  actorType: AuditEventRecord["actorType"];
  createdAt: number;
  envelopeId: string;
  event: AuditEventRecord["event"];
  id: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  userAgent: string | null;
};

function mapAuditRow(row: AuditEventRow): AuditEventRecord {
  return auditEventRecordSchema.parse({
    actorEmail: row.actorEmail,
    actorType: row.actorType,
    createdAt: row.createdAt,
    envelopeId: row.envelopeId,
    event: row.event,
    id: row.id,
    ipAddress: row.ipAddress,
    metadata: row.metadata,
    userAgent: row.userAgent,
  });
}

export async function listAuditEventsForEnvelope(
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<AuditEventRecord[]> {
  const rows = await queryMany<AuditEventRow>(
    database,
    `
      SELECT
        id,
        envelope_id AS "envelopeId",
        event,
        actor_type AS "actorType",
        actor_email AS "actorEmail",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        metadata,
        created_at AS "createdAt"
      FROM audit_events
      WHERE envelope_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [envelopeId],
  );

  return rows.map(mapAuditRow);
}

// Each envelope's audit events form a hash chain: every row stores the hash
// of the row before it and a hash over its own content. Changing, removing or
// reordering a row breaks the chain from that point on, which
// verifyAuditChain reports. Rows written before the chain existed have no
// sequence and are left out of it.

type ChainedFields = {
  actorEmail: string | null;
  actorType: string;
  createdAt: number;
  envelopeId: string;
  event: string;
  id: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  sequence: number;
  userAgent: string | null;
};

export function computeAuditRowHash(
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

async function insertChainedAuditEvent(
  input: RecordAuditEventInput,
  database: DbExecutor,
): Promise<AuditEventRecord> {
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);

  // Serializes writers for one envelope until the surrounding transaction
  // ends, so two events cannot take the same place in the chain.
  await database.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 7))",
    [input.envelopeId],
  );

  const previous = await database.query<{
    rowHash: string | null;
    sequence: number;
  }>(
    `
      SELECT sequence, row_hash AS "rowHash"
      FROM audit_events
      WHERE envelope_id = $1 AND sequence IS NOT NULL
      ORDER BY sequence DESC
      LIMIT 1
    `,
    [input.envelopeId],
  );
  const previousRow = previous.rows[0];
  const sequence = (previousRow?.sequence ?? 0) + 1;
  const previousHash = previousRow?.rowHash ?? null;
  const fields: ChainedFields = {
    actorEmail: input.actorEmail ?? null,
    actorType: input.actorType,
    createdAt,
    envelopeId: input.envelopeId,
    event: input.event,
    id,
    ipAddress: input.ipAddress ?? null,
    metadata: input.metadata ?? null,
    sequence,
    userAgent: input.userAgent ?? null,
  };

  await database.query(
    `
      INSERT INTO audit_events (
        id,
        envelope_id,
        event,
        actor_type,
        actor_email,
        ip_address,
        user_agent,
        metadata,
        created_at,
        sequence,
        prev_hash,
        row_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    [
      id,
      input.envelopeId,
      input.event,
      input.actorType,
      fields.actorEmail,
      fields.ipAddress,
      fields.userAgent,
      fields.metadata,
      createdAt,
      sequence,
      previousHash,
      computeAuditRowHash(previousHash, fields),
    ],
  );

  return auditEventRecordSchema.parse({
    actorEmail: fields.actorEmail,
    actorType: input.actorType,
    createdAt,
    envelopeId: input.envelopeId,
    event: input.event,
    id,
    ipAddress: fields.ipAddress,
    metadata: fields.metadata,
    userAgent: fields.userAgent,
  });
}

export async function recordAuditEvent(
  input: RecordAuditEventInput,
  database: DbExecutor = getDb(),
): Promise<AuditEventRecord> {
  if (isPool(database)) {
    return withTransaction(
      (client) => insertChainedAuditEvent(input, client),
      database,
    );
  }

  return insertChainedAuditEvent(input, database);
}

export type AuditChainCheck =
  | { chainedEvents: number; ok: true }
  | { brokenAtSequence: number; chainedEvents: number; ok: false };

/** Recomputes an envelope's chain and reports the first row that disagrees. */
export async function verifyAuditChain(
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<AuditChainCheck> {
  const result = await database.query<
    ChainedFields & { prevHash: string | null; rowHash: string | null }
  >(
    `
      SELECT
        id,
        envelope_id AS "envelopeId",
        event,
        actor_type AS "actorType",
        actor_email AS "actorEmail",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        metadata,
        created_at AS "createdAt",
        sequence,
        prev_hash AS "prevHash",
        row_hash AS "rowHash"
      FROM audit_events
      WHERE envelope_id = $1 AND sequence IS NOT NULL
      ORDER BY sequence ASC
    `,
    [envelopeId],
  );
  let previousHash: string | null = null;
  let expectedSequence = 1;

  for (const row of result.rows) {
    const { prevHash, rowHash, ...fields } = row;

    if (
      row.sequence !== expectedSequence ||
      prevHash !== previousHash ||
      rowHash !== computeAuditRowHash(previousHash, fields)
    ) {
      return {
        brokenAtSequence: expectedSequence,
        chainedEvents: result.rows.length,
        ok: false,
      };
    }

    previousHash = rowHash;
    expectedSequence += 1;
  }

  return { chainedEvents: result.rows.length, ok: true };
}

/** Notes that the mail provider accepted a message about this envelope. */
export async function recordEmailSent(
  input: {
    envelopeId: string;
    messageId?: string | null;
    recipient: string;
    signerId?: string | null;
    template: string;
  },
  database: DbExecutor = getDb(),
): Promise<void> {
  try {
    await recordAuditEvent(
      {
        actorType: "system",
        envelopeId: input.envelopeId,
        event: "email_sent",
        metadata: {
          messageId: input.messageId ?? null,
          recipient: input.recipient,
          signerId: input.signerId ?? null,
          template: input.template,
        },
      },
      database,
    );
  } catch (error) {
    // The email went out; failing to note it must not undo anything.
    console.error(
      `Failed to record email delivery for envelope ${input.envelopeId}:`,
      error,
    );
  }
}
