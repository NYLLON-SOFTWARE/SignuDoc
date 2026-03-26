import { randomUUID } from "node:crypto";

import {
  auditEventRecordSchema,
  type AuditEventRecord,
} from "../schemas/envelope.ts";
import { type DbExecutor, getDb, queryMany } from "../db/connection.ts";

export type AuditEventMetadata = Record<string, unknown> | null;

export type RecordAuditEventInput = {
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

export async function recordAuditEvent(
  input: RecordAuditEventInput,
  database: DbExecutor = getDb(),
): Promise<AuditEventRecord> {
  const id = randomUUID();
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);

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
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      id,
      input.envelopeId,
      input.event,
      input.actorType,
      input.actorEmail ?? null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      input.metadata ?? null,
      createdAt,
    ],
  );

  return auditEventRecordSchema.parse({
    actorEmail: input.actorEmail ?? null,
    actorType: input.actorType,
    createdAt,
    envelopeId: input.envelopeId,
    event: input.event,
    id,
    ipAddress: input.ipAddress ?? null,
    metadata: input.metadata ?? null,
    userAgent: input.userAgent ?? null,
  });
}
