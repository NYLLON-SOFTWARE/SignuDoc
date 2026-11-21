// Copies every row of one SignuDoc database into another, empty one, of
// either backend: SQLite to Postgres, Postgres to SQLite, or the same kind.
// It is SignuDoc's own backup and restore (src/lib/backup.ts) with nothing
// in between, so it checks what a restore checks: the target is migrated
// first, must have no accounts yet, and gets everything in one transaction
// or nothing. Files are not copied; both databases point at the same store.
// See docs/design/database-backends.md, "Switching backends later".
//
//   npm run transfer-database -- --from sqlite:signudoc.db --to postgres://...
//
// Stop the app that writes to --from first, so nothing changes during the
// copy.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import pg from "pg";

import { runMigrations } from "../db/migrate.mjs";
import {
  type BackupStore,
  exportDatabaseLines,
  restoreDatabase,
} from "../src/lib/backup.ts";
import { isSqliteUrl, SqlitePool } from "../src/lib/db/sqlite/pool.ts";

function readArgument(name: string): string | null {
  const index = process.argv.indexOf(name);

  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function openPool(connectionString: string): pg.Pool {
  return isSqliteUrl(connectionString)
    ? (new SqlitePool(connectionString) as unknown as pg.Pool)
    : new pg.Pool({ connectionString, max: 2 });
}

/** A backup store that keeps the one export in memory. */
function memoryStore(): BackupStore {
  const objects = new Map<string, Buffer>();

  return {
    async delete(pathnames) {
      pathnames.forEach((pathname) => objects.delete(pathname));
    },
    async get(pathname) {
      const body = objects.get(pathname);

      return body
        ? {
            contentType: "application/gzip",
            stream: new Blob([new Uint8Array(body)]).stream(),
          }
        : null;
    },
    async list() {
      return {
        blobs: [...objects].map(([pathname, body]) => ({
          pathname,
          size: body.length,
          uploadedAt: new Date(),
        })),
        hasMore: false,
      };
    },
    async put(pathname, body) {
      objects.set(pathname, body as Buffer);
    },
  };
}

async function main() {
  const from = readArgument("--from");
  const to = readArgument("--to");

  if (!from || !to) {
    console.error(
      "Usage: npm run transfer-database -- --from <database URL> --to <database URL>",
    );
    process.exit(1);
  }

  console.log("Migrating the target…");
  await runMigrations({ connectionString: to });

  const source = openPool(from);
  const target = openPool(to);

  try {
    console.log("Reading the source…");

    // Compressed as it is read, so the export is never one big string.
    const chunks: Buffer[] = [];

    // pipeline() passes a failed export on instead of waiting for data that
    // will not come.
    await pipeline(
      Readable.from(exportDatabaseLines(source, new Date())),
      createGzip(),
      async (compressed) => {
        for await (const chunk of compressed) {
          chunks.push(chunk as Buffer);
        }
      },
    );

    const store = memoryStore();
    const path = "database/transfer.ndjson.gz";

    await store.put(path, Buffer.concat(chunks), {
      contentType: "application/gzip",
    });

    console.log("Writing the target…");

    const { rows } = await restoreDatabase({
      backupPath: path,
      database: target,
      store,
    });

    for (const [table, count] of Object.entries(rows)) {
      console.log(`  ${table}: ${String(count)} rows`);
    }

    console.log("Done.");
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
