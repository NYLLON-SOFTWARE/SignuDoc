// The SQLite side of src/lib/db/test-database.ts: the database tests
// (npm run test:db) on the SQLite backend, with E2E_DATABASE_URL set to a
// sqlite: URL. Each test file runs in a process of its own, and gets the
// file new: the first open in a process deletes it and migrates it again.
// getDb() in the same process, pointed at the same URL (some tests set
// DATABASE_URL to it), shares the pool's connections and write lock.
import { rmSync } from "node:fs";

import type pg from "pg";

import { runMigrations } from "../../../../db/migrate.mjs";
import { isDisposableDatabase } from "../disposable-database.ts";
import { sqliteFilePath } from "./open.ts";
import { SqlitePool } from "./pool.ts";

const wiped = new Set<string>();

type QueryFunction = (text: unknown, values?: unknown[]) => Promise<unknown>;

/**
 * The same database, except that `then` runs right before one chosen
 * statement, whether it goes to the pool or to a client taken from it.
 * See afterStatementOrJustBefore in ../test-database.ts.
 */
export function beforeStatement(
  pool: pg.Pool,
  isTheStatement: (text: string, values: unknown[]) => boolean,
  then: () => Promise<void>,
): pg.Pool {
  function intercept<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, property) {
        const value: unknown = Reflect.get(object, property);

        if (property === "query") {
          const query: QueryFunction = async (text, values) => {
            if (
              typeof text === "string" &&
              isTheStatement(text, values ?? [])
            ) {
              await then();
            }

            return (value as QueryFunction).call(object, text, values);
          };

          return query;
        }

        if (property === "connect") {
          return async () =>
            intercept(
              await (value as () => Promise<pg.PoolClient>).call(object),
            );
        }

        return typeof value === "function"
          ? (value.bind(object) as unknown)
          : value;
      },
    });
  }

  return intercept(pool);
}

export async function openSqliteTestDatabase(
  connectionString: string,
): Promise<pg.Pool> {
  const file = sqliteFilePath(connectionString);

  if (!isDisposableDatabase(connectionString)) {
    throw new Error(
      `Refusing to run database tests on "${file}". The test database must have "e2e" in its name.`,
    );
  }

  if (!wiped.has(file)) {
    wiped.add(file);

    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(`${file}${suffix}`, { force: true });
    }
  }

  await runMigrations({ connectionString, log: () => undefined });

  return new SqlitePool(connectionString) as unknown as pg.Pool;
}
