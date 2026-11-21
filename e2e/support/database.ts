// The end-to-end tests' own way into the test database, on either backend
// (docs/design/database-backends.md). With a sqlite: URL the file is the
// one the app under test has open too; SQLite's file locks keep the two
// processes apart.
//
// The SQLite pool is loaded with import() when first used, never with a
// static import: Playwright compiles static imports to require(), and the
// db/sqlite/*.mjs modules it depends on are also loaded as ES modules by
// db/migrate.mjs in global-setup.ts. One module loaded both ways breaks.
import { rmSync } from "node:fs";
import path from "node:path";

import pg from "pg";

export function isSqliteUrl(connectionString: string): boolean {
  return /^sqlite:/i.test(connectionString.trim());
}

/** The file a sqlite: URL names (the same rule as db/sqlite/open.mjs). */
export function sqliteFile(connectionString: string): string {
  let rest = connectionString.trim().slice("sqlite:".length);

  if (rest.startsWith("//")) {
    rest = rest.slice(2);
  }

  return path.resolve(decodeURIComponent(rest.split("?")[0] ?? ""));
}

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  end: () => Promise<void>;
};

/** The SQLite pool, opened on first use; works where a Pool or a Client did. */
function lazySqlitePool(connectionString: string) {
  let opened: Promise<Queryable> | null = null;
  const open = () =>
    (opened ??= import("../../src/lib/db/sqlite/pool.ts").then(
      ({ SqlitePool }) =>
        new SqlitePool(connectionString) as unknown as Queryable,
    ));

  return {
    connect: async () => undefined,
    end: async () => {
      if (opened) {
        await (await opened).end();
      }
    },
    query: async (text: string, values?: unknown[]) =>
      (await open()).query(text, values),
  };
}

/** Instead of `new pg.Pool({ connectionString })`. */
export function openE2ePool(connectionString: string): pg.Pool {
  return isSqliteUrl(connectionString)
    ? (lazySqlitePool(connectionString) as unknown as pg.Pool)
    : new pg.Pool({ connectionString });
}

/** Instead of `new pg.Client({ connectionString })`: connect, query, end. */
export function openE2eClient(connectionString: string): pg.Client {
  return isSqliteUrl(connectionString)
    ? (lazySqlitePool(connectionString) as unknown as pg.Client)
    : new pg.Client({ connectionString });
}

/**
 * Empties a SQLite test database before the migrations run again: every
 * table, view and trigger is dropped, rather than the file deleted, in case
 * the app under test already has it open.
 */
export async function wipeSqliteDatabase(connectionString: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const file = sqliteFile(connectionString);

  if (!(await import("node:fs")).existsSync(file)) {
    return;
  }

  const database = new DatabaseSync(file, { timeout: 5000 });

  try {
    database.exec("PRAGMA foreign_keys = OFF");

    const objects = database
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string; type: string }[];

    for (const { name, type } of objects.filter(
      (object) => object.type !== "table",
    )) {
      database.exec(
        `DROP ${type.toUpperCase()} IF EXISTS "${name.replace(/"/g, '""')}"`,
      );
    }

    for (const { name } of objects.filter(
      (object) => object.type === "table",
    )) {
      database.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    database.close();
  }

  // Left over from a run that ended mid-write, a journal would be replayed.
  rmSync(`${file}-journal`, { force: true });
}
