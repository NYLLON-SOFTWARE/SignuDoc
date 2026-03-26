import pg, {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

import { getEnv } from "../utils/env.ts";
import { assertServiceConfig } from "../services/service-config.ts";

const DATABASE_ENV_KEYS = ["DATABASE_URL"] as const;

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

  assertServiceConfig("database", DATABASE_ENV_KEYS, process.env);

  const pool = new Pool({
    application_name: "signudoc",
    connectionString: getEnv().databaseUrl!,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: process.env.NODE_ENV === "production" ? 10 : 5,
  });

  pool.on("error", (error) => {
    console.error("[db] Postgres pool error", error);
  });

  if (process.env.NODE_ENV !== "production") {
    globalThis.__signudocPgPool = pool;
  }

  cachedPool = pool;
  return pool;
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
