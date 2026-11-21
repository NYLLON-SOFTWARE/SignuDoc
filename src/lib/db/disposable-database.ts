// Which databases the tests may wipe: only one with "e2e" in its name. The
// end-to-end setup and the database tests both drop everything in the
// database they are pointed at, so both ask here before they do.
import path from "node:path";

import { isSqliteUrl, sqliteFilePath } from "./sqlite/open.ts";

/** The database's name: for Postgres its name, for SQLite its file's own. */
export function disposableDatabaseName(connectionString: string): string {
  return isSqliteUrl(connectionString)
    ? path.basename(sqliteFilePath(connectionString))
    : new URL(connectionString).pathname.replace(/^\//, "");
}

export function isDisposableDatabase(connectionString: string): boolean {
  return disposableDatabaseName(connectionString).toLowerCase().includes("e2e");
}

export function assertDisposableDatabase(connectionString: string) {
  if (!isDisposableDatabase(connectionString)) {
    throw new Error(
      `Refusing to wipe database "${disposableDatabaseName(connectionString)}". The end-to-end test database must have "e2e" in its name.`,
    );
  }
}
