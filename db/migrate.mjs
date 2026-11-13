#!/usr/bin/env node
// Applies db/migrations/*.sql in filename order and records each one in the
// signudoc_migrations table. Safe to run repeatedly: applied files are skipped.
//
//   node db/migrate.mjs             apply pending migrations (fails without a database URL)
//   node db/migrate.mjs --optional  same, but exits cleanly when no database URL is set
//
// On Vercel this runs inside the build (see vercel.json). It only touches the
// database for production builds unless MIGRATE_ON_PREVIEW=1 is set, because
// preview deployments share the production database unless each preview has
// its own database branch.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import {
  DATABASE_URL_VARIABLES,
  normalizeDatabaseUrl,
  resolveMigrationDatabaseUrl,
} from "./database-url.mjs";

const DEFAULT_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

// Arbitrary constant shared by every migrator so two builds cannot run at once.
const ADVISORY_LOCK_ID = 746108321;

export async function listMigrationFiles(
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
) {
  const entries = await readdir(migrationsDir);

  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

export async function runMigrations({
  connectionString,
  log = console.log,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
}) {
  const client = new pg.Client({
    application_name: "signudoc-migrate",
    connectionString: normalizeDatabaseUrl(connectionString),
    connectionTimeoutMillis: 15_000,
  });

  await client.connect();

  try {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    await client.query(`
      create table if not exists public.signudoc_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const appliedResult = await client.query(
      "select version from public.signudoc_migrations",
    );
    const appliedVersions = new Set(
      appliedResult.rows.map((row) => row.version),
    );
    const files = await listMigrationFiles(migrationsDir);
    const applied = [];

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");

      if (appliedVersions.has(version)) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");

      await client.query("begin");

      try {
        await client.query(sql);
        await client.query(
          "insert into public.signudoc_migrations (version) values ($1)",
          [version],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw new Error(
          `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      log(`[migrate] applied ${file}`);
      applied.push(version);
    }

    return { applied, total: files.length };
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_ID])
      .catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

function loadLocalEnvFiles() {
  // Next.js loads these for the app; do the same for the CLI. Values already
  // present in the environment win.
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(process.cwd(), fileName);

    if (existsSync(filePath)) {
      process.loadEnvFile(filePath);
    }
  }
}

async function main() {
  const optional = process.argv.includes("--optional");

  loadLocalEnvFiles();

  if (
    process.env.VERCEL === "1" &&
    process.env.VERCEL_ENV !== "production" &&
    process.env.MIGRATE_ON_PREVIEW !== "1"
  ) {
    console.log(
      "[migrate] skipped: not a production build. Set MIGRATE_ON_PREVIEW=1 if previews have their own database.",
    );
    return;
  }

  const target = resolveMigrationDatabaseUrl();

  if (!target) {
    const message = `[migrate] no database URL found (looked for ${DATABASE_URL_VARIABLES.join(", ")}).`;

    if (optional) {
      console.warn(
        `${message} Skipping. Run "npm run db:migrate" once a database is connected, or deploy again.`,
      );
      return;
    }

    console.error(message);
    process.exitCode = 1;
    return;
  }

  const result = await runMigrations({ connectionString: target.value });

  console.log(
    result.applied.length > 0
      ? `[migrate] done: applied ${String(result.applied.length)} of ${String(result.total)} migration(s) using ${target.name}.`
      : `[migrate] done: database is up to date (${String(result.total)} migration(s), ${target.name}).`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error("[migrate] failed:", error);
    process.exitCode = 1;
  });
}
