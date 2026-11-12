import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";

// The accounts on this install and who among them is an administrator.
//
// An administrator can make another account an administrator or take that
// role away, their own included. There is always at least one: the last
// administrator cannot be removed, and neither can the last one whose
// account is not on its way to being closed.

/** Serializes role changes, so two removals cannot both leave "one more". */
const ROLE_CHANGE_LOCK_ID = 746108324;
const MAX_LISTED_PEOPLE = 500;

export type PersonRole = "admin" | "user";

export type Person = {
  /** The account has asked to be closed and is waiting out its notice. */
  closing: boolean;
  createdAt: string;
  email: string;
  emailVerified: boolean;
  id: string;
  name: string;
  role: PersonRole;
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
  name: string;
  role: string;
};

const PERSON_COLUMNS = `
  u.id,
  u.name,
  u.email,
  u.role,
  u."emailVerified" AS "emailVerified",
  u."createdAt" AS "createdAt",
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
    name: row.name,
    role: row.role === "admin" ? "admin" : "user",
  };
}

/** Every account, administrators first, then by name. */
export async function listPeople(
  database: DbExecutor = getDb(),
): Promise<Person[]> {
  const rows = await queryMany<PersonRow>(
    database,
    `
      SELECT ${PERSON_COLUMNS}
      FROM "user" u
      ORDER BY (u.role = 'admin') DESC, lower(u.name) ASC, u.id ASC
      LIMIT ${MAX_LISTED_PEOPLE}
    `,
  );

  return rows.map(mapPerson);
}

export function parsePersonRole(value: unknown): PersonRole | null {
  return value === "admin" || value === "user" ? value : null;
}

/**
 * Makes an account an administrator, or an ordinary account again.
 * Returns the account as it now is.
 */
export async function setPersonRole(
  targetUserId: string,
  role: PersonRole,
  database: DbPool = getDb(),
): Promise<Person> {
  return withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [ROLE_CHANGE_LOCK_ID]);

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
      const others = await queryOne<{ count: number }>(
        tx,
        `
          SELECT count(*)::int AS count
          FROM "user" u
          WHERE u.role = 'admin'
            AND u.id <> $1
            AND NOT EXISTS (
              SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
            )
        `,
        [targetUserId],
      );

      if ((others?.count ?? 0) === 0) {
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

    return mapPerson({ ...target, role });
  }, database);
}
