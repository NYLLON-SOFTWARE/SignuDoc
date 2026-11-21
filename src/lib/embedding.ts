import {
  getDb,
  queryMany,
  queryOne,
  withTransaction,
  type DbExecutor,
  type DbPool,
} from "./db/connection.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import type { EnvSource } from "./utils/env.ts";
import { parseEmbedOrigin } from "./embed-origin.ts";

export { httpEmbedOriginsAllowed, parseEmbedOrigin } from "./embed-origin.ts";

// Embedded signing: an app shows SignuDoc's signing page inside its own
// site, in a frame, instead of SignuDoc emailing the signer a link. See
// db/migrations/20261118120000_embedded_signing.sql and
// 20261118120500_embed_link_api_key.sql.
//
// - An administrator lists the sites allowed to frame signing pages.
// - An envelope sent through the API with delivery "embedded" emails no
//   invitations or reminders.
// - For each signer whose turn it is, the app asks the API for a link made
//   for one of those sites. Each request replaces the last link. A link
//   not opened within 15 minutes stops working; once opened it lasts for
//   the signing session.
// - The page at /embed/sign/{token}?origin=... may only be framed by that
//   origin (proxy.ts), opens only for the origin the link was made for,
//   and tells the parent page when the signer signs or declines.

export const MAX_EMBED_ORIGINS = 10;
/** How long a new link waits to be opened. */
export const EMBED_LINK_TTL_SECONDS = 15 * 60;
/** How long an opened link lasts, at most: one signing session. */
export const EMBED_SESSION_SECONDS = 4 * 60 * 60;

export class EmbeddingError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "EmbeddingError";
    this.statusCode = statusCode;
  }
}

type Actor = {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
};

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

export async function listEmbedOrigins(
  database: DbExecutor = getDb(),
): Promise<Array<{ createdAt: number; origin: string }>> {
  return queryMany(
    database,
    `
      SELECT origin, created_at AS "createdAt"
      FROM embed_allowed_origins
      ORDER BY created_at, origin
    `,
  );
}

export async function isEmbedOriginAllowed(
  origin: string,
  database: DbExecutor = getDb(),
): Promise<boolean> {
  const row = await queryOne<{ origin: string }>(
    database,
    `SELECT origin FROM embed_allowed_origins WHERE origin = $1`,
    [origin],
  );

  return row !== null;
}

export async function hasEmbedOrigins(
  database: DbExecutor = getDb(),
): Promise<boolean> {
  const row = await queryOne<{ any: boolean }>(
    database,
    `SELECT EXISTS (SELECT 1 FROM embed_allowed_origins) AS any`,
  );

  return row?.any ?? false;
}

async function requireAdmin(actor: Actor, tx: DbExecutor) {
  const row = await queryOne<{ role: string }>(
    tx,
    `SELECT role FROM "user" WHERE id = $1 FOR UPDATE`,
    [actor.userId],
  );

  if (row?.role !== "admin") {
    throw new EmbeddingError("Only an administrator can do this.", 403);
  }
}

export async function addEmbedOrigin(
  actor: Actor,
  value: unknown,
  options: { database?: DbPool; env?: EnvSource } = {},
): Promise<string> {
  const origin = parseEmbedOrigin(value, options.env);

  if (!origin) {
    throw new EmbeddingError(
      "Enter one site as https:// and its address, such as https://app.example.com, with no path.",
      400,
    );
  }

  await withTransaction(async (tx) => {
    await requireAdmin(actor, tx);
    await tx.query(
      `LOCK TABLE embed_allowed_origins IN SHARE ROW EXCLUSIVE MODE`,
    );

    // A site already on the list takes no new place, so adding it again
    // succeeds and changes nothing, even when the list is full.
    const count = await queryOne<{ count: number }>(
      tx,
      `SELECT count(*)::int AS count FROM embed_allowed_origins WHERE origin <> $1`,
      [origin],
    );

    if ((count?.count ?? 0) >= MAX_EMBED_ORIGINS) {
      throw new EmbeddingError(
        `Up to ${String(MAX_EMBED_ORIGINS)} sites can be allowed. Remove one first.`,
        409,
      );
    }

    const inserted = await tx.query(
      `
        INSERT INTO embed_allowed_origins (origin, created_by, created_at)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
      `,
      [origin, actor.userId, nowInSeconds()],
    );

    if ((inserted.rowCount ?? 0) === 1) {
      await recordSystemAuditEvent(
        {
          actorEmail: actor.email,
          actorUserId: actor.userId,
          event: "embed_origin_added",
          ipAddress: actor.ipAddress ?? null,
          metadata: { origin },
          userAgent: actor.userAgent ?? null,
        },
        tx,
      );
    }
  }, options.database ?? getDb());

  return origin;
}

export async function removeEmbedOrigin(
  actor: Actor,
  origin: string,
  database: DbPool = getDb(),
): Promise<void> {
  await withTransaction(async (tx) => {
    await requireAdmin(actor, tx);

    const removed = await tx.query(
      `DELETE FROM embed_allowed_origins WHERE origin = $1`,
      [origin],
    );

    if ((removed.rowCount ?? 0) === 0) {
      throw new EmbeddingError("That site is not on the list.", 404);
    }

    // Links already made for the site stop working at once, opened or
    // not. The signer's row is kept: the app can ask for a link for a
    // site that is still allowed.
    const now = nowInSeconds();

    await tx.query(
      `
        UPDATE signers
        SET signing_token_expires_at = LEAST(signing_token_expires_at, $2 - 1),
            updated_at = $2
        WHERE embed_origin = $1
          AND status = 'notified'
          AND signing_token_hash IS NOT NULL
      `,
      [origin, now],
    );

    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "embed_origin_removed",
        ipAddress: actor.ipAddress ?? null,
        metadata: { origin },
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);
}

/** The path of the embedded signing page for a token and origin. */
export function embedSigningPath(token: string, origin: string): string {
  return `/embed/sign/${encodeURIComponent(token)}?${new URLSearchParams({ origin }).toString()}`;
}

/**
 * A new signing link for a signer whose turn it is on an embedded
 * envelope of `userId`'s, made for `origin`. Replaces the signer's last
 * link.
 */
export async function issueEmbedLink(
  input: {
    /** The key asking for the link; the signature's evidence names it. */
    apiKeyId?: string | null;
    envelopeId: string;
    origin: unknown;
    signerId: string;
    userId: string;
  },
  options: { database?: DbPool; env?: EnvSource } = {},
): Promise<{ expiresAt: string; url: string }> {
  const database = options.database ?? getDb();
  const origin = parseEmbedOrigin(input.origin, options.env);

  if (!origin) {
    throw new EmbeddingError(
      "origin: give the exact origin of the page that frames the signer, such as https://app.example.com.",
      400,
    );
  }

  if (!(await isEmbedOriginAllowed(origin, database))) {
    throw new EmbeddingError(
      "origin: this site is not allowed to frame signing pages. An administrator can add it under Settings, Organization, Embedded signing.",
      403,
    );
  }

  const now = nowInSeconds();

  return withTransaction(async (tx) => {
    // Holds the site on the list until this link is saved. Removing the
    // site deletes this row and then expires its links, so it waits for
    // this link and expires it too, or goes first and this is refused.
    // Taken before any other lock here, so the two cannot deadlock.
    const stillAllowed = await queryOne<{ origin: string }>(
      tx,
      `SELECT origin FROM embed_allowed_origins WHERE origin = $1 FOR SHARE`,
      [origin],
    );

    if (!stillAllowed) {
      throw new EmbeddingError(
        "origin: this site is not allowed to frame signing pages. An administrator can add it under Settings, Organization, Embedded signing.",
        403,
      );
    }

    const envelope = await queryOne<{
      delivery: string;
      expiresAt: number | null;
      status: string;
    }>(
      tx,
      `
        SELECT delivery, status, expires_at AS "expiresAt"
        FROM envelopes WHERE id = $1 AND user_id = $2
        FOR NO KEY UPDATE
      `,
      [input.envelopeId, input.userId],
    );

    if (!envelope) {
      throw new EmbeddingError("Envelope not found.", 404);
    }

    if (envelope.delivery !== "embedded") {
      throw new EmbeddingError(
        'This envelope\'s signers get their links by email. Send it with delivery "embedded" to sign it in your app.',
        409,
      );
    }

    if (
      envelope.status !== "sent" ||
      (envelope.expiresAt !== null && envelope.expiresAt <= now)
    ) {
      throw new EmbeddingError(
        "This envelope is not out for signature any more.",
        409,
      );
    }

    const signer = await queryOne<{ status: string }>(
      tx,
      `
        SELECT status FROM signers
        WHERE id = $1 AND envelope_id = $2 AND role IN ('signer', 'approver')
        FOR UPDATE
      `,
      [input.signerId, input.envelopeId],
    );

    if (!signer) {
      throw new EmbeddingError("Signer not found.", 404);
    }

    if (signer.status !== "notified") {
      throw new EmbeddingError(
        signer.status === "pending"
          ? "It is not this signer's turn yet."
          : "This signer has already finished.",
        409,
      );
    }

    const lifetime = Math.min(
      EMBED_LINK_TTL_SECONDS,
      (envelope.expiresAt ?? now + EMBED_LINK_TTL_SECONDS) - now,
    );
    const link = await issueSigningLink(
      { expiresInSeconds: lifetime, issuedAt: now },
      { env: options.env },
    );

    await tx.query(
      `
        UPDATE signers
        SET signing_token_hash = $1, signing_token_expires_at = $2,
            embed_origin = $3, embed_link_opened_at = NULL, updated_at = $4,
            embed_api_key_id = $6
        WHERE id = $5
      `,
      [
        link.tokenHash,
        link.exp,
        origin,
        now,
        input.signerId,
        input.apiKeyId ?? null,
      ],
    );

    return {
      expiresAt: new Date(link.exp * 1000).toISOString(),
      url: new URL(
        embedSigningPath(link.token, origin),
        new URL(link.url).origin,
      ).toString(),
    };
  }, database);
}

export type EmbedOpenResult =
  | { ok: true }
  | { ok: false; reason: "not_embedded" | "wrong_origin" | "unknown" };

/**
 * Checks that an embedded link is opened for the site it was made for,
 * and on first opening gives it the rest of a signing session. Leaves
 * other problems (expired, already signed) to the signing page itself.
 *
 * A link that signing or declining took away (spent) passes the same site
 * checks, so its frame can show what happened (signed, completed) instead
 * of saying the link expired. It opens nothing: the signing page only
 * reports its state.
 */
export async function openEmbedLink(
  token: string,
  origin: string | null,
  database: DbPool = getDb(),
  now: number = nowInSeconds(),
): Promise<EmbedOpenResult> {
  const row = await queryOne<{
    delivery: string;
    embedLinkOpenedAt: number | null;
    embedOrigin: string | null;
    envelopeExpiresAt: number | null;
    expiresAt: number | null;
    id: string;
    live: boolean;
    originAllowed: boolean;
  }>(
    database,
    `
      SELECT s.id, s.embed_origin AS "embedOrigin",
        s.embed_link_opened_at AS "embedLinkOpenedAt",
        s.signing_token_expires_at AS "expiresAt",
        COALESCE(s.signing_token_hash = $1, false) AS "live",
        e.delivery, e.expires_at AS "envelopeExpiresAt",
        EXISTS (
          SELECT 1 FROM embed_allowed_origins a WHERE a.origin = s.embed_origin
        ) AS "originAllowed"
      FROM signers s
      JOIN envelopes e ON e.id = s.envelope_id
      WHERE s.signing_token_hash = $1 OR s.spent_signing_token_hash = $1
      ORDER BY "live" DESC
      LIMIT 1
    `,
    [hashOpaqueToken(token)],
  );

  if (!row) {
    return { ok: false, reason: "unknown" };
  }

  if (row.delivery !== "embedded") {
    return { ok: false, reason: "not_embedded" };
  }

  // The site must still be on the list: removing it stops its links.
  if (!origin || row.embedOrigin !== origin || !row.originAllowed) {
    return { ok: false, reason: "wrong_origin" };
  }

  if (!row.live) {
    return { ok: true };
  }

  if (
    row.embedLinkOpenedAt === null &&
    row.expiresAt !== null &&
    row.expiresAt >= now
  ) {
    const sessionEnd = Math.min(
      now + EMBED_SESSION_SECONDS,
      row.envelopeExpiresAt ?? now + EMBED_SESSION_SECONDS,
    );

    const stillAllowed = await withTransaction(async (tx) => {
      // Held while the link opens, as when it is issued. Removing the site
      // deletes this row, so it either waits and then expires the opened
      // link, or went first and the link does not open.
      const site = await tx.query(
        `SELECT origin FROM embed_allowed_origins WHERE origin = $1 FOR SHARE`,
        [origin],
      );

      if ((site.rowCount ?? 0) === 0) {
        return false;
      }

      // Matched on the token too: a link replaced since the read above
      // must not be marked opened, or given a session, by the old one.
      await tx.query(
        `
          UPDATE signers
          SET embed_link_opened_at = $2,
              signing_token_expires_at = GREATEST(signing_token_expires_at, $3)
          WHERE id = $1 AND embed_link_opened_at IS NULL
            AND signing_token_hash = $4 AND signing_token_expires_at >= $2
        `,
        [row.id, now, sessionEnd, hashOpaqueToken(token)],
      );

      return true;
    }, database);

    if (!stillAllowed) {
      return { ok: false, reason: "wrong_origin" };
    }
  }

  return { ok: true };
}

/** What a signature made through an embedded link records about it. */
export async function readEmbedEvidence(
  envelopeId: string,
  signerId: string,
  database: DbExecutor = getDb(),
): Promise<{ apiKeyName: string | null; origin: string | null } | null> {
  const row = await queryOne<{
    apiKeyName: string | null;
    delivery: string;
    origin: string | null;
  }>(
    database,
    `
      SELECT e.delivery, s.embed_origin AS origin, k.name AS "apiKeyName"
      FROM envelopes e
      JOIN signers s ON s.envelope_id = e.id AND s.id = $2
      -- The key that asked for this signer's link, not the one that made
      -- the envelope.
      LEFT JOIN api_keys k ON k.id = s.embed_api_key_id
      WHERE e.id = $1
    `,
    [envelopeId, signerId],
  );

  return row?.delivery === "embedded"
    ? { apiKeyName: row.apiKeyName, origin: row.origin }
    : null;
}

/** Whether an envelope's signers sign in another app. */
export async function isEmbeddedEnvelope(
  envelopeId: string,
  database: DbExecutor = getDb(),
  ownerId?: string,
): Promise<boolean> {
  const row = await queryOne<{ delivery: string }>(
    database,
    `
      SELECT delivery FROM envelopes
      WHERE id = $1 AND ($2::text IS NULL OR user_id = $2)
    `,
    [envelopeId, ownerId ?? null],
  );

  return row?.delivery === "embedded";
}
