// Opens the SQLite database named by a sqlite: connection string, with the
// settings every connection to it uses. Plain JavaScript so that
// db/migrate.mjs and the app (src/lib/db/sqlite/pool.ts) share it. See
// docs/design/database-backends.md.
//
//   sqlite:/absolute/path/file.db
//   sqlite:///absolute/path/file.db
//   sqlite:relative/path/file.db      (from the working directory)
import { mkdirSync } from "node:fs";
import path from "node:path";

/** How long a connection waits for another process's lock on the file. */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * @param {string | undefined | null} connectionString
 * @returns {boolean}
 */
export function isSqliteUrl(connectionString) {
  return (
    typeof connectionString === "string" &&
    connectionString.trim().toLowerCase().startsWith("sqlite:")
  );
}

/**
 * The file a sqlite: connection string names, as an absolute path.
 *
 * @param {string} connectionString
 * @returns {string}
 */
export function sqliteFilePath(connectionString) {
  if (!isSqliteUrl(connectionString)) {
    throw new Error("Not a sqlite: connection string.");
  }

  let rest = connectionString.trim().slice("sqlite:".length);

  // sqlite:///data/x.db is the URL form of /data/x.db.
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
  }

  rest = decodeURIComponent(rest.split("?")[0] ?? "");

  if (!rest) {
    throw new Error("The sqlite: connection string names no file.");
  }

  return path.resolve(rest);
}

/**
 * node:sqlite, loaded only when a SQLite database is used, so that nothing
 * changes for a Postgres install (and no bundler has to know about it).
 *
 * @returns {typeof import("node:sqlite")}
 */
export function loadNodeSqlite() {
  return /** @type {typeof import("node:sqlite")} */ (
    process.getBuiltinModule("node:sqlite")
  );
}

/**
 * lower() as Postgres has it: every letter folds, not only ASCII, which is all
 * SQLite's own lower() does. Every connection defines it, the ones that
 * migrate as well, because an index on lower(...) keeps the function's results:
 * two connections that disagree would corrupt it. It has to be deterministic
 * to be used in an index, and the schema trusted (SQLite's default) for an
 * index or trigger to call a function the connection defines.
 *
 * @param {unknown} value
 */
function lowerForSql(value) {
  if (value === null || value instanceof Uint8Array) {
    return value;
  }

  return String(value).toLowerCase();
}

/**
 * Opens the file, creating it (and its folder) unless `readOnly`. WAL lets
 * the read-only connection (and an outside reader) read while the app writes;
 * synchronous=FULL makes every commit durable on disk before it returns.
 *
 * @param {string} connectionString
 * @param {{ readOnly?: boolean }} [options]
 * @returns {import("node:sqlite").DatabaseSync}
 */
export function openSqliteDatabase(
  connectionString,
  { readOnly = false } = {},
) {
  const file = sqliteFilePath(connectionString);
  const { DatabaseSync } = loadNodeSqlite();

  if (!readOnly) {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  const database = new DatabaseSync(file, {
    enableForeignKeyConstraints: true,
    readOnly,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });

  try {
    database.function("lower", { deterministic: true }, lowerForSql);

    if (!readOnly) {
      database.exec("PRAGMA journal_mode = WAL");
    }

    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA busy_timeout = ${String(SQLITE_BUSY_TIMEOUT_MS)}`);
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
}
