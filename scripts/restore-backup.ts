// Restores a SignuDoc install from the daily backup (src/lib/backup.ts) into
// a new, empty database and Blob store. See docs/backup-and-restore.md.
//
//   DATABASE_URL=postgres://...            the new, empty database
//     (or sqlite:/path/file.db for the SQLite backend)
//   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_  the new install's Blob store
//   BACKUP_BLOB_READ_WRITE_TOKEN=...       the backup store
//
//   npm run restore-backup -- --list            list the database backups
//   npm run restore-backup                      restore the newest one, and the files
//   npm run restore-backup -- --backup <path>   restore that one
//   npm run restore-backup -- --skip-files      the database only
//   npm run restore-backup -- --files-only      the files only, for example to
//                                               finish a copy that stopped
//
// It applies the migrations first, then loads the backup in one transaction,
// so a restore that fails leaves the database as it was.

import pg from "pg";

import {
  createVercelBlobStore,
  DATABASE_PREFIX,
  findLatestDatabaseBackup,
  restoreDatabase,
  restoreFiles,
} from "../src/lib/backup.ts";
import { runMigrations } from "../db/migrate.mjs";
import { isSqliteUrl, SqlitePool } from "../src/lib/db/sqlite/pool.ts";

function readArgument(name: string): string | null {
  const index = process.argv.indexOf(name);

  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function requireVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    console.error(`Set ${name} first. See docs/backup-and-restore.md.`);
    process.exit(1);
  }

  return value;
}

async function main() {
  const backupStore = createVercelBlobStore(
    requireVariable("BACKUP_BLOB_READ_WRITE_TOKEN"),
  );

  if (process.argv.includes("--list")) {
    let cursor: string | undefined;

    do {
      const page = await backupStore.list({ cursor, prefix: DATABASE_PREFIX });

      for (const blob of page.blobs) {
        console.log(
          `${blob.pathname}  ${String(Math.round(blob.size / 1024))} KB`,
        );
      }

      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    return;
  }

  const filesOnly = process.argv.includes("--files-only");
  const skipFiles = process.argv.includes("--skip-files");

  if (filesOnly && skipFiles) {
    console.error("Choose --files-only or --skip-files, not both.");
    process.exit(1);
  }

  const appStore = skipFiles
    ? null
    : createVercelBlobStore(requireVariable("BLOB_READ_WRITE_TOKEN"));

  if (!filesOnly) {
    const connectionString = requireVariable("DATABASE_URL");
    const backupPath =
      readArgument("--backup") ?? (await findLatestDatabaseBackup(backupStore));

    if (!backupPath) {
      console.error("The backup store has no database backups yet.");
      process.exit(1);
    }

    console.log("Applying migrations…");
    await runMigrations({ connectionString });

    // A sqlite: URL restores into a SQLite file (docs/design/database-backends.md).
    const database = isSqliteUrl(connectionString)
      ? (new SqlitePool(connectionString) as unknown as pg.Pool)
      : new pg.Pool({ connectionString, max: 2 });

    try {
      console.log(`Restoring ${backupPath}…`);

      const { revoked, rows } = await restoreDatabase({
        backupPath,
        database,
        store: backupStore,
      });

      for (const [table, count] of Object.entries(rows)) {
        console.log(`  ${table}: ${String(count)} rows`);
      }

      console.log(
        [
          "Ended what the backup had of sign-ins and links, so none of them works again:",
          `  ${String(revoked.sessions)} sessions (everyone signs in again)`,
          `  ${String(revoked.verifications)} one-time codes and reset links`,
          `  ${String(revoked.signingLinks)} signing links (senders send a reminder for a new one)`,
          `  ${String(revoked.providerSessions)} signatures under way at a signing provider`,
        ].join("\n"),
      );
    } finally {
      await database.end();
    }
  }

  if (appStore) {
    console.log("Copying files…");

    const { copied, failures, skipped } = await restoreFiles({
      source: backupStore,
      target: appStore,
    });

    console.log(
      `  ${String(copied)} files copied, ${String(skipped)} already there.`,
    );

    if (failures.length > 0) {
      console.error(`  ${String(failures.length)} could not be copied:`);

      for (const pathname of failures) {
        console.error(`    ${pathname}`);
      }

      console.error(
        "  Run it again with --files-only to retry them; files already copied are skipped.",
      );
      process.exitCode = 1;
    }
  }

  console.log("Done. Deploy the new install and sign in to check it.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
