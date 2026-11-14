import { attachDatabasePool } from "@vercel/functions";
import pg, {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

import { getEnv } from "../utils/env.ts";
import { requireConfigValue } from "../services/service-config.ts";

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

  const isOnVercel = process.env.VERCEL === "1";
  const pool = new Pool({
    application_name: "signudoc",
    connectionString: requireConfigValue(
      "database",
      "DATABASE_URL",
      getEnv().databaseUrl,
    ),
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

export async function withTransaction<T>(
  run: (client: PoolClient) => Promise<T>,
  pool: Pool = getDb(),
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
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
