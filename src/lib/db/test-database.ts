import pg from "pg";

import { runMigrations } from "../../../db/migrate.mjs";

// For the tests that need a real Postgres (npm run test:db). They use the
// same disposable database as the end-to-end test, bring its schema up to
// date, and leave whatever else is in it alone.

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
