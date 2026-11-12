import { NextResponse } from "next/server";

import { getDb, queryOne, type DbExecutor } from "../db/connection.ts";
import { isMissingSchemaError } from "../settings.ts";
import { requireVerifiedSenderSession } from "./route-session.ts";

/**
 * Whether this user is the install's administrator. Asked of the database
 * every time rather than read from the session, which is cached in a cookie
 * for a few minutes and could be out of date.
 */
export async function isAdminUser(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<boolean> {
  try {
    const row = await queryOne<{ role: string }>(
      database,
      `select role from public."user" where id = $1`,
      [userId],
    );

    return row?.role === "admin";
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return false;
    }

    throw error;
  }
}

/** For API routes only an administrator may call. */
export async function requireAdminSession(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  if (!(await isAdminUser(sessionResult.user.id))) {
    return NextResponse.json(
      { error: "Only an administrator can do this." },
      { status: 403 },
    );
  }

  return sessionResult;
}
