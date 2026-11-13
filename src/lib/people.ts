import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";

// The accounts on this install and who among them is an administrator.
//
// An administrator can make another account an administrator or take that
// role away, their own included. There is always at least one: the last
// administrator cannot be removed, and neither can the last one whose
// account is not on its way to being closed.

/** Serializes role changes, so two removals cannot both leave "one more". */
const ROLE_CHANGE_LOCK_ID = 746108324;
const MAX_LISTED_PEOPLE = 500;
const MAX_SEARCH_LENGTH = 100;

export type PersonRole = "admin" | "user";

export type Person = {
  /** The account has asked to be closed and is waiting out its notice. */
  closing: boolean;
  createdAt: string;
  email: string;
  emailVerified: boolean;
  id: string;
  /** When an administrator confirmed who this is, for Part 11 signing. */
  identityVerifiedAt: number | null;
  identityVerificationNote: string | null;
  name: string;
  role: PersonRole;
  /** When wrong passwords at signing locked the account for signing. */
  signingLockedAt: number | null;
};

export type PeopleList = {
  /** Administrators among every account, not only the ones listed. */
  administratorCount: number;
  /** The first accounts that match, at most five hundred of them. */
  people: Person[];
  /** How many accounts match. More than `people` holds when it was cut. */
  total: number;
};

export class PeopleError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "PeopleError";
    this.statusCode = statusCode;
  }
}

type PersonRow = {
  closing: boolean;
  createdAt: Date;
  email: string;
  emailVerified: boolean;
  id: string;
  identityVerificationNote: string | null;
  identityVerifiedAt: number | null;
  name: string;
  role: string;
  signingLockedAt: number | null;
};

const PERSON_COLUMNS = `
  u.id,
  u.name,
  u.email,
  u.role,
  u."emailVerified" AS "emailVerified",
  u."createdAt" AS "createdAt",
  u.identity_verified_at AS "identityVerifiedAt",
  u.identity_verification_note AS "identityVerificationNote",
  u.signing_locked_at AS "signingLockedAt",
  EXISTS (
    SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
  ) AS closing
`;

function mapPerson(row: PersonRow): Person {
  return {
    closing: row.closing,
    createdAt: row.createdAt.toISOString(),
    email: row.email,
    emailVerified: row.emailVerified,
    id: row.id,
    identityVerificationNote: row.identityVerificationNote ?? null,
    identityVerifiedAt: row.identityVerifiedAt ?? null,
    name: row.name,
    role: row.role === "admin" ? "admin" : "user",
    signingLockedAt: row.signingLockedAt ?? null,
  };
}

// Part of a name or of an email address, whatever its case. Nothing typed
// matches everyone.
const MATCHES_SEARCH = `(
  position($1 in lower(u.name)) > 0 OR position($1 in lower(u.email)) > 0
)`;

/**
 * The accounts, administrators first, then by name. The list stops at five
 * hundred, so the search is done here and not on what a page was sent: an
 * account further down has to be findable, or it could never be made an
 * administrator.
 */
export async function listPeople(
  { search = "" }: { search?: string } = {},
  database: DbExecutor = getDb(),
): Promise<PeopleList> {
  const needle = search.trim().toLowerCase().slice(0, MAX_SEARCH_LENGTH);
  const rows = await queryMany<PersonRow>(
    database,
    `
      SELECT ${PERSON_COLUMNS}
      FROM "user" u
      WHERE ${MATCHES_SEARCH}
      ORDER BY (u.role = 'admin') DESC, lower(u.name) ASC, u.id ASC
      LIMIT ${MAX_LISTED_PEOPLE}
    `,
    [needle],
  );
  const counts = await queryOne<{ administratorCount: number; total: number }>(
    database,
    `
      SELECT
        count(*) FILTER (WHERE ${MATCHES_SEARCH})::int AS total,
        count(*) FILTER (WHERE u.role = 'admin')::int AS "administratorCount"
      FROM "user" u
    `,
    [needle],
  );

  return {
    administratorCount: counts?.administratorCount ?? 0,
    people: rows.map(mapPerson),
    // Never fewer than are listed, should an account arrive in between.
    total: Math.max(counts?.total ?? 0, rows.length),
  };
}

/**
 * The administrator who keeps the organization's records: the one who has
 * been here longest and whose own account is not on its way to being
 * closed. `exceptUserId` is the account that is giving the records up.
 * Returns null when there is no such administrator.
 */
export async function findRecordKeeper(
  exceptUserId: string,
  database: DbExecutor,
): Promise<string | null> {
  const keeper = await queryOne<{ id: string }>(
    database,
    `
      SELECT u.id
      FROM "user" u
      WHERE u.id <> $1
        AND u.role = 'admin'
        AND NOT EXISTS (
          SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
        )
      ORDER BY u."createdAt" ASC, u.id ASC
      LIMIT 1
    `,
    [exceptUserId],
  );

  return keeper?.id ?? null;
}

export function parsePersonRole(value: unknown): PersonRole | null {
  return value === "admin" || value === "user" ? value : null;
}

/**
 * Makes an account an administrator, or an ordinary account again, for the
 * administrator `actingUserId`. Returns the account as it now is.
 *
 * Whoever calls this has already checked that the acting account is an
 * administrator, but that was before this waited its turn. Another
 * administrator may have taken the role away in the meantime, so it is
 * looked at again here, where no role can change underneath it. Without
 * that, a request already under way would let someone who has just been
 * removed put themselves back.
 *
 * Taking the role away also takes away the finished envelopes the account
 * was handed from closed accounts. Those were given to an administrator to
 * keep for the organization, so they go to one who stays. The envelopes
 * the account sent itself are its own and stay where they are.
 */
export async function setPersonRole(
  actingUserId: string,
  targetUserId: string,
  role: PersonRole,
  database: DbPool = getDb(),
): Promise<Person> {
  return withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [ROLE_CHANGE_LOCK_ID]);

    const actor = await queryOne<{ email: string; role: string }>(
      tx,
      `SELECT u.role, u.email FROM "user" u WHERE u.id = $1`,
      [actingUserId],
    );

    if (actor?.role !== "admin") {
      throw new PeopleError("Only an administrator can do this.", 403);
    }

    const target = await queryOne<PersonRow>(
      tx,
      `SELECT ${PERSON_COLUMNS} FROM "user" u WHERE u.id = $1 FOR UPDATE OF u`,
      [targetUserId],
    );

    if (!target) {
      throw new PeopleError("That account no longer exists.", 404);
    }

    if (target.role === role) {
      return mapPerson(target);
    }

    let keeperId: string | null = null;

    if (role === "admin") {
      if (!target.emailVerified) {
        throw new PeopleError(
          "This person has not confirmed their email address yet. They can be made an administrator once they have.",
          409,
        );
      }

      if (target.closing) {
        throw new PeopleError(
          "This account is being closed, so it cannot become an administrator.",
          409,
        );
      }
    } else {
      // The administrator who stays, and who takes over the records.
      keeperId = await findRecordKeeper(targetUserId, tx);

      if (!keeperId) {
        throw new PeopleError(
          "There has to be at least one administrator. Make someone else an administrator first.",
          409,
        );
      }
    }

    await tx.query(
      `UPDATE "user" SET role = $1, "updatedAt" = now() WHERE id = $2`,
      [role, targetUserId],
    );
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actingUserId,
        event: "role_changed",
        metadata: {
          from: target.role,
          targetEmail: target.email,
          targetName: target.name,
          to: role,
        },
        targetUserId,
      },
      tx,
    );

    if (keeperId) {
      // The account's row has been held since it was read above. A closed
      // account's envelopes are handed over only while holding the
      // keeper's row too, so none can arrive here after this has looked.
      const moved = await tx.query(
        `
          UPDATE envelopes
          SET user_id = $1
          WHERE user_id = $2 AND handed_over_at IS NOT NULL
        `,
        [keeperId, targetUserId],
      );

      if ((moved.rowCount ?? 0) > 0) {
        console.info(
          `Moved ${moved.rowCount} handed-over envelopes from ${targetUserId}, no longer an administrator, to ${keeperId}.`,
        );
      }
    }

    return mapPerson({ ...target, role });
  }, database);
}
