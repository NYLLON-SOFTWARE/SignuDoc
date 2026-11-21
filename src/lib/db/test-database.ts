import pg from "pg";

import { runMigrations } from "../../../db/migrate.mjs";
import {
  lockEnvelopeAuditChain,
  recordAuditEvent,
  type RecordAuditEventInput,
} from "../services/audit.ts";
import { isSqliteUrl, SqlitePool } from "./sqlite/pool.ts";
import {
  beforeStatement,
  openSqliteTestDatabase,
} from "./sqlite/test-database.ts";

// For the tests that need a real Postgres (npm run test:db). They use the
// same disposable database as the end-to-end test and bring its schema up
// to date. Some of them empty its accounts and settings, which the
// end-to-end test does on every run anyway.

const DEFAULT_TEST_DATABASE_URL =
  "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";

async function ensureDatabaseExists(connectionString: string, name: string) {
  const maintenanceUrl = new URL(connectionString);

  maintenanceUrl.pathname = "/postgres";

  const client = new pg.Client({
    connectionString: maintenanceUrl.toString(),
  });

  try {
    await client.connect();

    const existing = await client.query(
      "select 1 from pg_database where datname = $1",
      [name],
    );

    if (existing.rowCount === 0) {
      await client.query(`create database "${name}"`);
    }
  } catch {
    // No access to the maintenance database: assume the test database was
    // made some other way and let the connection below report any problem.
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function openTestDatabase(): Promise<pg.Pool> {
  const connectionString =
    process.env.E2E_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

  // A fresh SQLite file per test file (sqlite/test-database.ts).
  if (isSqliteUrl(connectionString)) {
    return openSqliteTestDatabase(connectionString);
  }
  const name = new URL(connectionString).pathname.replace(/^\//, "");

  if (!name.toLowerCase().includes("e2e")) {
    throw new Error(
      `Refusing to run database tests on "${name}". The test database must have "e2e" in its name.`,
    );
  }

  await ensureDatabaseExists(connectionString, name);
  await runMigrations({ connectionString, log: () => undefined });

  return new pg.Pool({ connectionString, max: 12 });
}

/**
 * Resolves once another session is waiting on a lock that `holder` has,
 * so a test can check what that session holds while it waits. Fails if
 * none does within about five seconds.
 */
export async function waitUntilBlockedBy(
  database: pg.Pool,
  holder: pg.PoolClient,
): Promise<void> {
  const self = await holder.query<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );
  const holderPid = self.rows[0]?.pid;

  for (let attempt = 0; attempt < 500; attempt += 1) {
    const waiting = await database.query(
      `
        select 1
        from pg_stat_activity
        where $1::integer = any(pg_blocking_pids(pid))
        limit 1
      `,
      [holderPid],
    );

    if (waiting.rowCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Nothing started waiting on the held lock.");
}

/**
 * Another pool on the same test database, for a test that needs one of its
 * own. On SQLite it shares the database's one write lock, and
 * `connectionTimeoutMillis` is how long it waits for it.
 */
export function openAnotherPool(
  database: pg.Pool,
  options: { connectionTimeoutMillis: number; max: number },
): pg.Pool {
  const { connectionString } = (
    database as unknown as { options: pg.PoolConfig }
  ).options;

  if (connectionString && isSqliteUrl(connectionString)) {
    return new SqlitePool(connectionString, {
      lockTimeoutMs: options.connectionTimeoutMillis,
    }) as unknown as pg.Pool;
  }

  return new pg.Pool({ connectionString, ...options });
}

/**
 * afterStatement, for a `then` that writes as another session would while
 * the statement's transaction holds its rows, and waits for that write. On
 * SQLite nothing can be written while a transaction holds the database, so
 * there `then` runs right before the statement instead: the last moment the
 * same write can land.
 */
export function afterStatementOrJustBefore(
  pool: pg.Pool,
  isTheStatement: (text: string, values: unknown[]) => boolean,
  then: () => Promise<void>,
): pg.Pool {
  return isSqliteUrl(process.env.E2E_DATABASE_URL ?? "")
    ? beforeStatement(pool, isTheStatement, then)
    : afterStatement(pool, isTheStatement, then);
}

/**
 * Writes made from inside another transaction's work, as another session
 * would make them meanwhile. On Postgres each goes through at once. SQLite
 * has one writer, so there it waits for the open transaction to end: it is
 * started at once and awaited by `settled()`.
 */
export function besideOpenTransactions() {
  const onSqlite = isSqliteUrl(process.env.E2E_DATABASE_URL ?? "");
  const pending: Promise<unknown>[] = [];

  return {
    async run(write: () => Promise<unknown>) {
      const written = write();

      if (!onSqlite) {
        await written;
        return;
      }

      written.catch(() => undefined);
      pending.push(written);
    },
    settled: () => Promise.all(pending),
  };
}

type QueryFunction = (text: unknown, values?: unknown[]) => unknown;

/**
 * The same database, except that `then` runs right after one chosen
 * statement has, whether it went to the pool or to a client taken from it.
 */
export function afterStatement(
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
            const result = await (value as QueryFunction).call(
              object,
              text,
              values,
            );

            if (
              typeof text === "string" &&
              isTheStatement(text, values ?? [])
            ) {
              await then();
            }

            return result;
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

/**
 * Records an audit event the way a signer opening the signing page does,
 * timed against something else that writes to the same envelope: the
 * event's transaction takes the envelope's audit chain, `start()` gets
 * under way until it has to wait for that chain, and only then is the event
 * stored.
 *
 * Storing it checks the event's foreign key, which needs a share of the
 * envelope's row. So if `start()` holds that row too tightly while it
 * waits, each waits for the other, Postgres cancels one of them, and this
 * rejects.
 */
export async function recordAuditEventWhileWaitedOn<T>(
  database: pg.Pool,
  event: RecordAuditEventInput,
  start: () => Promise<T>,
): Promise<T> {
  const client = await database.connect();

  try {
    await client.query("begin");
    await lockEnvelopeAuditChain(event.envelopeId, client);

    const started = start();

    // Looked at below. Until then a rejection must not go unhandled.
    started.catch(() => undefined);

    for (let attempt = 0; ; attempt += 1) {
      const waiting = await database.query(
        `select 1 from pg_locks where locktype = 'advisory' and not granted limit 1`,
      );

      if (waiting.rowCount) {
        break;
      }

      if (attempt === 500) {
        throw new Error("Nothing came to wait for the audit chain.");
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await recordAuditEvent(event, client);
    await client.query("commit");

    return await started;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * For a test where one session waits on row locks another holds
 * (waitUntilBlockedBy), or writes while another's transaction holds the
 * rows it writes to. SQLite has one writer, so the two can never overlap
 * there.
 */
export const needsPostgresLocks = {
  skip: isSqliteUrl(process.env.E2E_DATABASE_URL ?? "")
    ? "needs Postgres"
    : false,
};
