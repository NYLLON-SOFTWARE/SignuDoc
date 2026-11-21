import { attachDatabasePool } from "@vercel/functions";
import pg, {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

import { getEnv } from "../utils/env.ts";
import { requireConfigValue } from "../services/service-config.ts";
import { isSqliteUrl, SqlitePool } from "./sqlite/pool.ts";

declare global {
  var __signudocPgPool: Pool | undefined;
}

// Parse bigint values into numbers because this app stores timestamps and counts
// that are already modeled as numbers throughout the codebase.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));

let cachedPool: Pool | null = null;

export type DbExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;
export type DbPool = Pool;

export function getDb(): Pool {
  if (cachedPool) {
    return cachedPool;
  }

  if (globalThis.__signudocPgPool) {
    cachedPool = globalThis.__signudocPgPool;
    return cachedPool;
  }

  const connectionString = requireConfigValue(
    "database",
    "DATABASE_URL",
    getEnv().databaseUrl,
  );

  // A sqlite: URL picks the SQLite backend (docs/design/database-backends.md).
  if (isSqliteUrl(connectionString)) {
    cachedPool = new SqlitePool(connectionString) as unknown as Pool;
    return cachedPool;
  }

  const isOnVercel = process.env.VERCEL === "1";
  const pool = new Pool({
    application_name: "signudoc",
    connectionString,
    connectionTimeoutMillis: 10_000,
    // A Vercel function instance is suspended between requests, so idle
    // connections are released quickly there instead of being left to die.
    idleTimeoutMillis: isOnVercel ? 5_000 : 30_000,
    max: process.env.NODE_ENV === "production" ? 10 : 5,
  });

  pool.on("error", (error) => {
    console.error("[db] Postgres pool error", error);
  });

  if (isOnVercel) {
    // Keeps the instance alive just long enough to close idle connections
    // before it is suspended, so they do not pile up on the database.
    attachDatabasePool(pool);
  }

  if (process.env.NODE_ENV !== "production") {
    globalThis.__signudocPgPool = pool;
  }

  cachedPool = pool;
  return pool;
}

/**
 * Makes getDb() return this pool from now on, for tests that need the code
 * under test to use a pool of their own. Returns the pool it replaces.
 */
export function replaceDbPoolForTests(pool: Pool): Pool | null {
  const replaced = cachedPool;

  cachedPool = pool;
  globalThis.__signudocPgPool = pool;

  return replaced;
}

// Work to do once a transaction has committed, such as writing a log line
// about a row it inserted: a line about a row that was rolled back would
// describe something that never happened.
const commitCallbacks = new WeakMap<object, (() => void)[]>();

/**
 * Runs `callback` once the transaction `database` belongs to has committed,
 * or at once when `database` is not inside one. Dropped on rollback.
 */
export function afterCommit(database: DbExecutor, callback: () => void): void {
  const pending = commitCallbacks.get(database);

  if (pending) {
    pending.push(callback);
    return;
  }

  callback();
}

export async function withTransaction<T>(
  run: (client: PoolClient) => Promise<T>,
  pool: Pool = getDb(),
): Promise<T> {
  const client = await pool.connect();
  const pending: (() => void)[] = [];

  commitCallbacks.set(client, pending);

  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    commitCallbacks.delete(client);

    for (const callback of pending) {
      try {
        callback();
      } catch (error) {
        console.error("[db] A step after commit failed:", error);
      }
    }

    return result;
  } catch (error) {
    commitCallbacks.delete(client);
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  db: DbExecutor,
  text: string,
  values: readonly unknown[] = [],
): Promise<T | null> {
  const result: QueryResult<T> = await db.query(text, values as unknown[]);
  return result.rows[0] ?? null;
}

export async function queryMany<T extends QueryResultRow>(
  db: DbExecutor,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result: QueryResult<T> = await db.query(text, values as unknown[]);
  return result.rows;
}
