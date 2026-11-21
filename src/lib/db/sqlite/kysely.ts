// A Kysely dialect for Better Auth that runs on the app's own SQLite pool,
// so Better Auth shares its write lock, its read-only connection and its
// type conversion. Better Auth's own node:sqlite dialect would run
// statements on the connection without the lock, where they could land in
// the middle of one of the app's transactions.
//
// See docs/design/database-backends.md, "Better Auth".
import {
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from "kysely";

import { isSqlitePool, type SqliteClient, type SqlitePool } from "./pool.ts";

/**
 * What Better Auth is given as its database: the pg pool as it is, or for
 * the SQLite pool a Kysely dialect over it.
 */
export function betterAuthDatabase<T>(
  database: T,
): T | { dialect: Dialect; transaction: true; type: "sqlite" } {
  return isSqlitePool(database)
    ? {
        dialect: createSqliteDialect(database),
        transaction: true,
        type: "sqlite",
      }
    : database;
}

class PoolConnection implements DatabaseConnection {
  readonly client: SqliteClient;

  constructor(client: SqliteClient) {
    this.client = client;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.client.queryRaw(
      compiledQuery.sql,
      compiledQuery.parameters,
    );
    const changed =
      result.command === "INSERT" ||
      result.command === "UPDATE" ||
      result.command === "DELETE";

    return {
      ...(changed ? { numAffectedRows: BigInt(result.rowCount) } : {}),
      rows: result.rows as R[],
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("The SQLite backend does not stream query results.");
  }
}

class PoolDriver implements Driver {
  private readonly pool: SqlitePool;

  constructor(pool: SqlitePool) {
    this.pool = pool;
  }

  async init() {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new PoolConnection(await this.pool.connect());
  }

  async beginTransaction(connection: DatabaseConnection) {
    await (connection as PoolConnection).client.query("BEGIN");
  }

  async commitTransaction(connection: DatabaseConnection) {
    await (connection as PoolConnection).client.query("COMMIT");
  }

  async rollbackTransaction(connection: DatabaseConnection) {
    await (connection as PoolConnection).client.query("ROLLBACK");
  }

  async releaseConnection(connection: DatabaseConnection) {
    (connection as PoolConnection).client.release();
  }

  // The pool belongs to the app, which ends it.
  async destroy() {}
}

export function createSqliteDialect(pool: SqlitePool): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new PoolDriver(pool),
    createIntrospector: (db: Kysely<unknown>) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}
