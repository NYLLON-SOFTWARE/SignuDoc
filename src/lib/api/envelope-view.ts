import { z } from "zod";

import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
  type DbPool,
} from "../db/connection.ts";
import { signingStepOf } from "../signing-steps.ts";
import type {
  EnvelopeStatus,
  RecipientRole,
  SignerStatus,
} from "../types/domain.ts";

// How the public API shows an envelope: one shape, ApiEnvelope, returned by
// every endpoint and carried by webhooks. Only reads here, so the webhook
// outbox can build payloads without pulling in the code that changes
// envelopes.

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export type ApiSigner = {
  declinedAt: string | null;
  declineReason: string | null;
  email: string;
  id: string;
  name: string;
  order: number;
  ref: string | null;
  /**
   * "approver" for someone who approves or rejects instead of signing. An
   * approval shows as `signed`, a rejection as `declined`.
   */
  role: RecipientRole;
  signedAt: string | null;
  status: SignerStatus;
  /** Signers who share a step sign at the same time. */
  step: number;
  viewedAt: string | null;
};

export type ApiEnvelope = {
  completedAt: string | null;
  copyRecipients: Array<{ email: string; id: string; name: string }>;
  createdAt: string;
  declinedAt: string | null;
  /** "email", or "embedded" when signers sign inside the calling app. */
  delivery: "email" | "embedded";
  expired: boolean;
  expiresAt: string | null;
  files: { certificate: string | null; signed: string | null };
  id: string;
  metadata: Record<string, unknown> | null;
  object: "envelope";
  pageCount: number;
  sentAt: string | null;
  signatureLevel: string;
  signers: ApiSigner[];
  status: EnvelopeStatus;
  title: string;
  voidedAt: string | null;
};

export function isoTime(seconds: number | null | undefined): string | null {
  return typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : null;
}

type EnvelopeRow = {
  apiMetadata: Record<string, unknown> | null;
  delivery: "email" | "embedded";
  completedAt: number | null;
  createdAt: number;
  declinedAt: number | null;
  evidenceKey: string | null;
  expiresAt: number | null;
  id: string;
  pageCount: number;
  sentAt: number | null;
  signatureLevel: string | null;
  signedPdfKey: string | null;
  status: EnvelopeStatus;
  title: string;
  voidedAt: number | null;
};

type SignerRow = {
  apiRef: string | null;
  declinedAt: number | null;
  declineReason: string | null;
  email: string;
  envelopeId: string;
  id: string;
  name: string;
  role: "cc" | RecipientRole;
  signedAt: number | null;
  signingStep: number | null;
  signOrder: number;
  status: SignerStatus;
  viewedAt: number | null;
};

const ENVELOPE_COLUMNS = `
  e.id,
  e.title,
  e.status,
  e.page_count AS "pageCount",
  e.signed_pdf_key AS "signedPdfKey",
  e.evidence_key AS "evidenceKey",
  e.sent_at AS "sentAt",
  e.completed_at AS "completedAt",
  e.declined_at AS "declinedAt",
  e.voided_at AS "voidedAt",
  e.expires_at AS "expiresAt",
  e.signature_level AS "signatureLevel",
  e.api_metadata AS "apiMetadata",
  e.delivery,
  e.created_at AS "createdAt"
`;

async function readSigners(
  envelopeIds: string[],
  database: DbExecutor,
): Promise<Map<string, SignerRow[]>> {
  const bySignerEnvelope = new Map<string, SignerRow[]>();

  if (envelopeIds.length === 0) {
    return bySignerEnvelope;
  }

  const rows = await queryMany<SignerRow>(
    database,
    `
      SELECT
        s.id,
        s.envelope_id AS "envelopeId",
        s.name,
        s.email,
        s.role,
        s.sign_order AS "signOrder",
        s.signing_step AS "signingStep",
        s.status,
        s.signed_at AS "signedAt",
        s.declined_at AS "declinedAt",
        s.decline_reason AS "declineReason",
        s.api_ref AS "apiRef",
        (
          SELECT min(a.created_at)
          FROM audit_events a
          WHERE a.envelope_id = s.envelope_id
            AND a.event = 'viewed'
            AND a.metadata->>'signerId' = s.id
            -- A corrected signer keeps the id but not the old person's view.
            AND lower(a.metadata->>'signerEmail') = lower(s.email)
        ) AS "viewedAt"
      FROM signers s
      WHERE s.envelope_id = ANY($1)
      ORDER BY s.envelope_id, s.sign_order, s.id
    `,
    [envelopeIds],
  );

  for (const row of rows) {
    const list = bySignerEnvelope.get(row.envelopeId) ?? [];

    list.push(row);
    bySignerEnvelope.set(row.envelopeId, list);
  }

  return bySignerEnvelope;
}

export function toApiEnvelope(
  row: EnvelopeRow,
  signers: SignerRow[],
  now: number = Math.floor(Date.now() / 1000),
): ApiEnvelope {
  const base = `/api/v1/envelopes/${encodeURIComponent(row.id)}/files`;
  const finished =
    row.status === "completed" ||
    row.status === "declined" ||
    row.status === "voided";

  return {
    completedAt: isoTime(row.completedAt),
    copyRecipients: signers
      .filter((signer) => signer.role === "cc")
      .map((signer) => ({
        email: signer.email,
        id: signer.id,
        name: signer.name,
      })),
    createdAt: isoTime(row.createdAt) ?? new Date(0).toISOString(),
    declinedAt: isoTime(row.declinedAt),
    delivery: row.delivery,
    expired:
      row.status === "sent" && row.expiresAt !== null && row.expiresAt <= now,
    expiresAt: isoTime(row.expiresAt),
    files: {
      certificate: finished ? `${base}/certificate` : null,
      signed: row.status === "completed" ? `${base}/signed` : null,
    },
    id: row.id,
    metadata: row.apiMetadata,
    object: "envelope",
    pageCount: row.pageCount,
    sentAt: isoTime(row.sentAt),
    signatureLevel: row.signatureLevel ?? "simple",
    signers: signers
      .filter((signer) => signer.role !== "cc")
      .map((signer) => ({
        declinedAt: isoTime(signer.declinedAt),
        declineReason: signer.declineReason,
        email: signer.email,
        id: signer.id,
        name: signer.name,
        order: signer.signOrder,
        ref: signer.apiRef,
        role: signer.role === "approver" ? "approver" : "signer",
        signedAt: isoTime(signer.signedAt),
        status: signer.status,
        step: signingStepOf(signer),
        viewedAt: isoTime(signer.viewedAt),
      })),
    status: row.status,
    title: row.title,
    voidedAt: isoTime(row.voidedAt),
  };
}

/** One envelope the account can see, or null. */
export async function getApiEnvelope(
  userId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<ApiEnvelope | null> {
  const row = await queryOne<EnvelopeRow>(
    database,
    `SELECT ${ENVELOPE_COLUMNS} FROM envelopes e WHERE e.id = $1 AND e.user_id = $2`,
    [envelopeId, userId],
  );

  if (!row) {
    return null;
  }

  const signers = await readSigners([row.id], database);

  return toApiEnvelope(row, signers.get(row.id) ?? []);
}

function isPool(database: DbExecutor): database is DbPool {
  return "connect" in database && "totalCount" in database;
}

/**
 * Runs `read` on one snapshot of the database, so reads that belong
 * together cannot straddle a change that commits between them. Given a
 * client, the caller's own transaction decides.
 */
async function readOnOneSnapshot<T>(
  database: DbExecutor,
  read: (executor: DbExecutor) => Promise<T>,
): Promise<T> {
  if (!isPool(database)) {
    return read(database);
  }

  const client = await database.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await read(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * An envelope with its owner, whoever that is, for webhook payloads, which
 * go to endpoints set up for the whole install. Null once it is deleted.
 * The envelope and its signers are read on one snapshot: a payload is kept
 * for every retry, so it must never show a completion half-way, such as a
 * sent envelope whose signers have all signed.
 */
export async function getApiEnvelopeWithOwner(
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<{
  envelope: ApiEnvelope;
  owner: { email: string; id: string; name: string };
} | null> {
  return readOnOneSnapshot(database, (snapshot) =>
    readApiEnvelopeWithOwner(envelopeId, snapshot),
  );
}

async function readApiEnvelopeWithOwner(
  envelopeId: string,
  database: DbExecutor,
): Promise<{
  envelope: ApiEnvelope;
  owner: { email: string; id: string; name: string };
} | null> {
  const row = await queryOne<
    EnvelopeRow & { ownerEmail: string; ownerId: string; ownerName: string }
  >(
    database,
    `
      SELECT ${ENVELOPE_COLUMNS},
        u.id AS "ownerId", u.email AS "ownerEmail", u.name AS "ownerName"
      FROM envelopes e
      JOIN "user" u ON u.id = e.user_id
      WHERE e.id = $1
    `,
    [envelopeId],
  );

  if (!row) {
    return null;
  }

  const signers = await readSigners([row.id], database);

  return {
    envelope: toApiEnvelope(row, signers.get(row.id) ?? []),
    owner: { email: row.ownerEmail, id: row.ownerId, name: row.ownerName },
  };
}

export function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${String(createdAt)}:${id}`, "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(
  cursor: string,
): { createdAt: number; id: string } | null {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");

  if (separator <= 0) {
    return null;
  }

  const createdAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  return Number.isSafeInteger(createdAt) && id.length > 0
    ? { createdAt, id }
    : null;
}

export const apiListQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  status: z
    .enum(["draft", "sent", "completed", "declined", "voided"])
    .optional(),
});

/**
 * The account's envelopes, newest first, a page at a time. Null for a
 * cursor this API did not give out.
 */
export async function listApiEnvelopes(
  userId: string,
  query: z.infer<typeof apiListQuerySchema>,
  database: DbExecutor = getDb(),
): Promise<{ data: ApiEnvelope[]; nextCursor: string | null } | null> {
  const values: unknown[] = [userId];
  const clauses = ["e.user_id = $1"];

  if (query.status) {
    values.push(query.status);
    clauses.push(`e.status = $${String(values.length)}`);
  }

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);

    if (!cursor) {
      return null;
    }

    values.push(cursor.createdAt, cursor.id);
    clauses.push(
      `(e.created_at, e.id) < ($${String(values.length - 1)}, $${String(values.length)})`,
    );
  }

  values.push(query.limit + 1);

  const rows = await queryMany<EnvelopeRow>(
    database,
    `
      SELECT ${ENVELOPE_COLUMNS}
      FROM envelopes e
      WHERE ${clauses.join(" AND ")}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${String(values.length)}
    `,
    values,
  );
  const page = rows.slice(0, query.limit);
  const signers = await readSigners(
    page.map((row) => row.id),
    database,
  );
  const last = page.at(-1);

  return {
    data: page.map((row) => toApiEnvelope(row, signers.get(row.id) ?? [])),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor(last.createdAt, last.id)
        : null,
  };
}

type AuditRow = {
  actorEmail: string | null;
  actorType: string;
  createdAt: number;
  event: string;
  id: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
};

/** The envelope's audit trail, oldest first, as the API returns it. */
export async function listApiEnvelopeEvents(
  userId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
) {
  const owner = await queryOne<{ id: string }>(
    database,
    `SELECT id FROM envelopes WHERE id = $1 AND user_id = $2`,
    [envelopeId, userId],
  );

  if (!owner) {
    return null;
  }

  const rows = await queryMany<AuditRow>(
    database,
    `
      SELECT
        id,
        event,
        actor_type AS "actorType",
        actor_email AS "actorEmail",
        ip_address AS "ipAddress",
        metadata,
        created_at AS "createdAt"
      FROM audit_events
      WHERE envelope_id = $1
      -- Events from before the audit chain have no sequence and come
      -- first, in the same order as the envelope's audit trail.
      ORDER BY sequence ASC NULLS FIRST, created_at ASC, id ASC
    `,
    [envelopeId],
  );

  return rows.map((row) => ({
    actor: { email: row.actorEmail, type: row.actorType },
    at: isoTime(row.createdAt),
    event: row.event,
    id: row.id,
    ipAddress: row.ipAddress,
    metadata: row.metadata,
  }));
}
