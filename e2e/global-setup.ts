import { rm } from "node:fs/promises";

import pg from "pg";

import { e2eDataDir, e2eDatabaseUrl } from "../playwright.config";

function assertDisposableDatabase(connectionString: string) {
  const databaseName = new URL(connectionString).pathname.replace(/^\//, "");

  if (!databaseName.toLowerCase().includes("e2e")) {
    throw new Error(
      `Refusing to wipe database "${databaseName}". The end-to-end test database must have "e2e" in its name.`,
    );
  }
}

async function ensureDatabaseExists(connectionString: string) {
  const targetUrl = new URL(connectionString);
  const databaseName = targetUrl.pathname.replace(/^\//, "");
  const adminUrl = new URL(connectionString);

  adminUrl.pathname = "/postgres";

  const client = new pg.Client({ connectionString: adminUrl.toString() });

  try {
    await client.connect();

    const existing = await client.query(
      "select 1 from pg_database where datname = $1",
      [databaseName],
    );

    if (existing.rowCount === 0) {
      await client.query(`create database "${databaseName}"`);
    }
  } catch {
    // No access to the maintenance database: assume the test database was
    // created some other way and let the reset below report any real problem.
  } finally {
    await client.end().catch(() => undefined);
  }
}

export default async function globalSetup() {
  assertDisposableDatabase(e2eDatabaseUrl);
  await ensureDatabaseExists(e2eDatabaseUrl);

  const client = new pg.Client({ connectionString: e2eDatabaseUrl });

  await client.connect();

  try {
    await client.query("drop schema if exists public cascade");
    await client.query("create schema public");
  } finally {
    await client.end();
  }

  // Called directly with the test database, so a DATABASE_URL_UNPOOLED or
  // similar in the developer's own environment cannot redirect it.
  // The runner is an ES module, so it is loaded with import() rather than a
  // static import that Playwright would compile to require().
  const { runMigrations } = await import("../db/migrate.mjs");

  await runMigrations({ connectionString: e2eDatabaseUrl });

  await rm(e2eDataDir, { force: true, recursive: true });
}
