import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import { del, get, list, put } from "@vercel/blob";

import { type DbPool, getDb } from "./db/connection.ts";
import {
  exportSqliteDatabaseLines,
  restoreIntoSqlite,
} from "./db/sqlite/backup.ts";
import { isSqlitePool } from "./db/sqlite/pool.ts";
import { readEnv, type EnvSource } from "./utils/env.ts";

// A daily copy of the install to a second Vercel Blob store, kept by the
// deployer apart from the first (another Vercel team, ideally), so that a
// deleted project, store or database, or a bug that deletes rows, is not the
// end of the records.
//
// It is off unless BACKUP_BLOB_READ_WRITE_TOKEN is set: a read-write token
// for that second store, which must be a private store. Each run
//
// - writes the whole database, read in one consistent snapshot, as one
//   gzipped NDJSON file under database/, and keeps BACKUP_KEEP_DAYS days of
//   them (30 by default, and never fewer than the newest three);
// - copies each file in the install's store that is new or changed since the
//   last run to files/<same path>. A file that is gone from the install's
//   store (deleted by the retention rules, say) is kept for BACKUP_KEEP_DAYS
//   more days and then removed, so a backup does not keep a document longer
//   than the retention rules allow by more than that.
//
// docs/backup-and-restore.md has the restore steps (scripts/restore-backup.ts).

export const BACKUP_FORMAT = "signudoc-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const DATABASE_PREFIX = "database/";
export const FILES_PREFIX = "files/";
const MANIFEST_PATH = "manifest.json";
const DEFAULT_KEEP_DAYS = 30;
const MIN_DATABASE_COPIES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows read from Postgres at a time while the database is written out. */
const EXPORT_BATCH_ROWS = 500;

/** The table migrate.mjs keeps; restore runs the migrations itself. */
export const MIGRATIONS_TABLE = "signudoc_migrations";

export type BackupBlob = { pathname: string; size: number; uploadedAt: Date };

/** The part of a Blob store a backup uses. Replaced by a fake in tests. */
export type BackupStore = {
  delete(pathnames: string[]): Promise<void>;
  get(pathname: string): Promise<{
    contentType: string;
    stream: ReadableStream<Uint8Array>;
  } | null>;
  list(options: { cursor?: string; prefix?: string }): Promise<{
    blobs: BackupBlob[];
    cursor?: string;
    hasMore: boolean;
  }>;
  put(
    pathname: string,
    body: ReadableStream<Uint8Array> | Readable | Buffer | string,
    options: { contentType: string },
  ): Promise<void>;
};

/** A private Vercel Blob store: the app's own (no token) or the backup's. */
export function createVercelBlobStore(token?: string): BackupStore {
  const auth = token ? { token } : {};

  return {
    async delete(pathnames) {
      if (pathnames.length > 0) {
        await del(pathnames, auth);
      }
    },
    async get(pathname) {
      const result = await get(pathname, {
        ...auth,
        access: "private",
        useCache: false,
      });

      if (!result || result.statusCode !== 200) {
        return null;
      }

      return { contentType: result.blob.contentType, stream: result.stream };
    },
    async list({ cursor, prefix }) {
      const result = await list({ ...auth, cursor, limit: 1000, prefix });

      return {
        blobs: result.blobs.map((blob) => ({
          pathname: blob.pathname,
          size: blob.size,
          uploadedAt: blob.uploadedAt,
        })),
        cursor: result.cursor,
        hasMore: result.hasMore,
      };
    },
    async put(pathname, body, { contentType }) {
      await put(pathname, body, {
        ...auth,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
        multipart: typeof body !== "string" && !Buffer.isBuffer(body),
      });
    },
  };
}

export type BackupSettings = { keepDays: number; token: string };

/** The backup settings, or null when backups are not set up. */
export function readBackupSettings(
  env: EnvSource = process.env,
): BackupSettings | null {
  const token = readEnv(env, "BACKUP_BLOB_READ_WRITE_TOKEN");

  if (!token) {
    return null;
  }

  const keepDays = Number.parseInt(readEnv(env, "BACKUP_KEEP_DAYS") ?? "", 10);

  return {
    keepDays:
      Number.isFinite(keepDays) && keepDays >= 1 && keepDays <= 3650
        ? keepDays
        : DEFAULT_KEEP_DAYS,
    token,
  };
}

/** The store id inside a Blob read-write token, when it has one. */
function storeIdFromToken(token: string | undefined): string | null {
  return /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(token ?? "")?.[1] ?? null;
}

/**
 * True when the backup token is for the app's own store. A backup there
 * would not survive what it is for, and would copy itself every night.
 */
export function isBackupStoreTheAppStore(
  settings: BackupSettings,
  env: EnvSource = process.env,
): boolean {
  const backupStore = storeIdFromToken(settings.token)?.toLowerCase();
  const appStores = [
    storeIdFromToken(readEnv(env, "BLOB_READ_WRITE_TOKEN")),
    readEnv(env, "BLOB_STORE_ID")?.replace(/^store_/, "") ?? null,
  ]
    .filter((id): id is string => Boolean(id))
    .map((id) => id.toLowerCase());

  return Boolean(backupStore && appStores.includes(backupStore));
}

/**
 * Lets go of a download that was not used up, so its connection is not
 * held open until it is collected.
 */
async function discardStream(stream: ReadableStream<Uint8Array> | undefined) {
  try {
    await stream?.cancel();
  } catch {
    // Already read, or closed: nothing is held.
  }
}

async function listAll(store: BackupStore, prefix?: string) {
  const blobs: BackupBlob[] = [];
  let cursor: string | undefined;

  do {
    const page = await store.list({ cursor, prefix });

    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return blobs;
}

/** The public tables, in an order that inserts parents before children. */
export async function listTablesInRestoreOrder(
  database: Pick<DbPool, "query">,
): Promise<string[]> {
  const tables = await database.query<{ name: string }>(
    `
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `,
  );
  const references = await database.query<{ child: string; parent: string }>(
    `
      SELECT DISTINCT child.relname AS child, parent.relname AS parent
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
        AND child.relname <> parent.relname
    `,
  );
  const parents = new Map<string, Set<string>>();

  for (const { name } of tables.rows) {
    parents.set(name, new Set());
  }

  for (const { child, parent } of references.rows) {
    parents.get(child)?.add(parent);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();

  while (ordered.length < parents.size) {
    const ready = [...parents.keys()].filter(
      (name) =>
        !placed.has(name) &&
        [...(parents.get(name) ?? [])].every(
          (parent) => placed.has(parent) || !parents.has(parent),
        ),
    );

    // A cycle between tables: put the rest in name order and let the
    // restore report what does not fit.
    const next =
      ready.length > 0
        ? ready
        : [...parents.keys()].filter((name) => !placed.has(name));

    for (const name of next) {
      placed.add(name);
      ordered.push(name);
    }
  }

  return ordered;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The database as NDJSON lines: a header, then one line per row, each
 * read with row_to_json so every Postgres type comes back as it went in.
 * Read in one repeatable-read snapshot, so the tables agree with each other.
 */
export async function* exportDatabaseLines(
  database: DbPool,
  createdAt: Date,
): AsyncGenerator<string> {
  if (isSqlitePool(database)) {
    yield* exportSqliteDatabaseLines(database, {
      createdAt,
      format: BACKUP_FORMAT,
      migrationsTable: MIGRATIONS_TABLE,
      version: BACKUP_FORMAT_VERSION,
    });
    return;
  }

  const client = await database.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const tables = await listTablesInRestoreOrder(client);
    const migrations = await client
      .query<{ name: string }>(
        `SELECT version AS name FROM ${MIGRATIONS_TABLE} ORDER BY version`,
      )
      .then((result) => result.rows.map((row) => row.name))
      .catch(() => [] as string[]);

    yield `${JSON.stringify({
      createdAt: createdAt.toISOString(),
      format: BACKUP_FORMAT,
      migrations,
      tables,
      version: BACKUP_FORMAT_VERSION,
    })}\n`;

    for (const table of tables) {
      if (table === MIGRATIONS_TABLE) {
        continue;
      }

      const cursorName = `backup_${String(tables.indexOf(table))}`;

      await client.query(
        `DECLARE ${cursorName} NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM ${quoteIdentifier(table)} t`,
      );

      for (;;) {
        const batch = await client.query<{ row: string }>(
          `FETCH ${String(EXPORT_BATCH_ROWS)} FROM ${cursorName}`,
        );

        for (const { row } of batch.rows) {
          yield `{"table":${JSON.stringify(table)},"row":${row}}\n`;
        }

        if (batch.rows.length < EXPORT_BATCH_ROWS) {
          break;
        }
      }

      await client.query(`CLOSE ${cursorName}`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function databaseBackupPath(createdAt: Date): string {
  return `${DATABASE_PREFIX}${createdAt.toISOString().replace(/[:.]/g, "-")}.ndjson.gz`;
}

type Manifest = {
  /**
   * For each copied file, the original's upload time as listed just before
   * it was read. A copy counts as current only while the original still
   * shows that time and size, so an original overwritten during or after a
   * copy is copied again on the next run.
   */
  copiedFrom: Record<string, string>;
  /** Backed-up files whose original was found missing, and since when. */
  missingSince: Record<string, string>;
  version: 1;
};

// Only a manifest that is not there yet starts empty. One that cannot be
// read stops the run: starting over would restart the clock on every
// deleted file, and keep them past BACKUP_KEEP_DAYS.
async function readManifest(store: BackupStore): Promise<Manifest> {
  const found = await store.get(MANIFEST_PATH);

  if (!found) {
    return { copiedFrom: {}, missingSince: {}, version: 1 };
  }

  const text = await new Response(found.stream).text();
  const parsed = JSON.parse(text) as Partial<Manifest>;

  return {
    copiedFrom: parsed.copiedFrom ?? {},
    missingSince: parsed.missingSince ?? {},
    version: 1,
  };
}

export type BackupSummary = {
  databaseBackup: string;
  databaseBackupsRemoved: number;
  fileFailures: string[];
  filesCopied: number;
  filesRemoved: number;
  filesUnchanged: number;
  /** True when time ran out; the next run carries on. */
  stoppedEarly: boolean;
};

/** Runs one backup. Copying files stops at `deadline`. */
export async function runBackup({
  database = getDb(),
  deadline = Date.now() + 240_000,
  keepDays,
  now = new Date(),
  source,
  target,
}: {
  database?: DbPool;
  deadline?: number;
  keepDays: number;
  now?: Date;
  source: BackupStore;
  target: BackupStore;
}): Promise<BackupSummary> {
  // 1. The database.
  const databaseBackup = databaseBackupPath(now);

  // pipeline() passes a failed export on to the upload, so it ends with
  // that error rather than waiting for data that will not come.
  // If the upload fails first, the export is stopped and waited for, so
  // its snapshot transaction and connection are let go before this returns.
  const compressed = createGzip();
  const exporting = pipeline(
    Readable.from(exportDatabaseLines(database, now)),
    compressed,
  );

  try {
    await Promise.all([
      exporting,
      target.put(databaseBackup, compressed, {
        contentType: "application/gzip",
      }),
    ]);
  } catch (error) {
    compressed.destroy(
      error instanceof Error ? error : new Error(String(error)),
    );
    await exporting.catch(() => undefined);
    throw error;
  }

  const cutoff = now.getTime() - keepDays * DAY_MS;
  const databaseCopies = (await listAll(target, DATABASE_PREFIX)).sort((a, b) =>
    b.pathname.localeCompare(a.pathname),
  );
  const expiredCopies = databaseCopies
    .slice(MIN_DATABASE_COPIES)
    .filter((blob) => blob.uploadedAt.getTime() < cutoff)
    .map((blob) => blob.pathname);

  await target.delete(expiredCopies);

  // 2. The files.
  const manifest = await readManifest(target);
  const originals = await listAll(source);
  // Carried over for files this run does not reach before its deadline.
  const copiedFrom: Record<string, string> = {};

  for (const original of originals) {
    const earlier = manifest.copiedFrom[original.pathname];

    if (earlier) {
      copiedFrom[original.pathname] = earlier;
    }
  }
  const copies = new Map(
    (await listAll(target, FILES_PREFIX)).map((blob) => [
      blob.pathname.slice(FILES_PREFIX.length),
      blob,
    ]),
  );
  const summary: BackupSummary = {
    databaseBackup,
    databaseBackupsRemoved: expiredCopies.length,
    fileFailures: [],
    filesCopied: 0,
    filesRemoved: 0,
    filesUnchanged: 0,
    stoppedEarly: false,
  };

  for (const original of originals) {
    const copy = copies.get(original.pathname);
    const version = original.uploadedAt.toISOString();

    if (
      copy &&
      copy.size === original.size &&
      manifest.copiedFrom[original.pathname] === version
    ) {
      summary.filesUnchanged += 1;
      continue;
    }

    if (Date.now() >= deadline) {
      summary.stoppedEarly = true;
      break;
    }

    // Until this copy is done, the one in the backup is not this version.
    delete copiedFrom[original.pathname];

    let found: Awaited<ReturnType<BackupStore["get"]>> = null;

    try {
      found = await source.get(original.pathname);

      if (!found) {
        continue;
      }

      await target.put(`${FILES_PREFIX}${original.pathname}`, found.stream, {
        contentType: found.contentType,
      });
      copiedFrom[original.pathname] = version;
      summary.filesCopied += 1;
    } catch (error) {
      await discardStream(found?.stream);
      summary.fileFailures.push(original.pathname);
      console.error(
        `[backup] Could not copy ${original.pathname}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // 3. Copies whose original is gone, kept keepDays days after it went.
  const present = new Set(originals.map((blob) => blob.pathname));
  const missingSince: Record<string, string> = {};
  const toRemove: string[] = [];

  for (const pathname of copies.keys()) {
    if (present.has(pathname)) {
      continue;
    }

    const since = manifest.missingSince[pathname] ?? now.toISOString();

    if (Date.parse(since) < cutoff) {
      toRemove.push(`${FILES_PREFIX}${pathname}`);
    } else {
      missingSince[pathname] = since;
    }
  }

  await target.delete(toRemove);
  summary.filesRemoved = toRemove.length;
  await target.put(
    MANIFEST_PATH,
    JSON.stringify({ copiedFrom, missingSince, version: 1 } satisfies Manifest),
    { contentType: "application/json" },
  );

  return summary;
}

/** Reads a database backup back as its header and rows. */
export async function* readDatabaseBackup(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<
  | {
      header: {
        createdAt: string;
        format: string;
        migrations: string[];
        tables: string[];
        version: number;
      };
      kind: "header";
    }
  | { kind: "row"; row: unknown; table: string }
> {
  const lines = createGunzip();

  // A read error ends the loop below with that error.
  pipeline(
    Readable.fromWeb(stream as import("node:stream/web").ReadableStream),
    lines,
  ).catch(() => {});
  // Decoded as one stream, so a character split between two chunks stays
  // whole.
  lines.setEncoding("utf8");

  let buffered = "";
  let first = true;

  for await (const chunk of lines) {
    buffered += chunk as string;

    let newline = buffered.indexOf("\n");

    while (newline >= 0) {
      const line = buffered.slice(0, newline);

      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");

      if (!line.trim()) {
        continue;
      }

      const parsed = JSON.parse(line) as Record<string, unknown>;

      if (first) {
        first = false;

        if (parsed.format !== BACKUP_FORMAT) {
          throw new Error("This is not a SignuDoc database backup.");
        }

        yield {
          header: parsed as never,
          kind: "header",
        };
        continue;
      }

      yield {
        kind: "row",
        row: parsed.row,
        table: String(parsed.table),
      };
    }
  }
}

/** The newest database backup in the store, or null if it has none. */
export async function findLatestDatabaseBackup(
  store: BackupStore,
): Promise<string | null> {
  const copies = await listAll(store, DATABASE_PREFIX);

  copies.sort((a, b) => b.pathname.localeCompare(a.pathname));

  return copies[0]?.pathname ?? null;
}

export class RestoreError extends Error {}

const RESTORE_BATCH_ROWS = 500;

/**
 * Loads a database backup into an empty database that has the same or
 * newer migrations applied. All of it lands in one transaction, or none.
 */
export async function restoreDatabase({
  backupPath,
  database,
  store,
}: {
  backupPath: string;
  database: DbPool;
  store: BackupStore;
}): Promise<{ revoked: RevokedCredentials; rows: Record<string, number> }> {
  const found = await store.get(backupPath);

  if (!found) {
    throw new RestoreError(`There is no backup at ${backupPath}.`);
  }

  const applied = new Set(
    (
      await database.query<{ version: string }>(
        `SELECT version FROM ${MIGRATIONS_TABLE}`,
      )
    ).rows.map((row) => row.version),
  );
  const existing = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "user"`,
  );

  if (existing.rows[0]?.count !== "0") {
    throw new RestoreError(
      "The database already has accounts in it. Restore into a new, empty database.",
    );
  }

  if (isSqlitePool(database)) {
    const { finished, rows } = await restoreIntoSqlite({
      applied,
      entries: readDatabaseBackup(found.stream),
      fail: (message) => new RestoreError(message),
      // As below for Postgres, in the restore's own transaction.
      finish: async (client, backupMigrations) => {
        await backfillRowsFromOlderBackup(client, backupMigrations);

        return revokeRestoredCredentials(client);
      },
      migrationsTable: MIGRATIONS_TABLE,
      pool: database,
    });

    return { revoked: finished, rows };
  }

  const client = await database.connect();
  const counts: Record<string, number> = {};
  let batchTable: string | null = null;
  let batch: unknown[] = [];
  let backupMigrations = new Set<string>();

  async function flush() {
    if (!batchTable || batch.length === 0) {
      return;
    }

    const columns = Object.keys(batch[0] as Record<string, unknown>)
      .map(quoteIdentifier)
      .join(", ");
    const table = quoteIdentifier(batchTable);

    // Only the columns the backup has, so a column added by a newer
    // migration gets its default.
    await client.query(
      `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM json_populate_recordset(null::${table}, $1::json)`,
      [JSON.stringify(batch)],
    );
    counts[batchTable] = (counts[batchTable] ?? 0) + batch.length;
    batch = [];
  }

  try {
    await client.query("BEGIN");

    for await (const entry of readDatabaseBackup(found.stream)) {
      if (entry.kind === "header") {
        const missing = entry.header.migrations.filter(
          (version) => !applied.has(version),
        );

        if (missing.length > 0) {
          throw new RestoreError(
            `The backup is from a newer version of SignuDoc. Update this copy first; it lacks ${missing.join(", ")}.`,
          );
        }

        backupMigrations = new Set(entry.header.migrations);

        // A new install can already have a row or two of its own (a seal
        // key, its settings). The backup's take their place.
        for (const table of [...entry.header.tables].reverse()) {
          if (table !== MIGRATIONS_TABLE) {
            await client.query(`DELETE FROM ${quoteIdentifier(table)}`);
          }
        }

        continue;
      }

      if (entry.table !== batchTable || batch.length >= RESTORE_BATCH_ROWS) {
        await flush();
        batchTable = entry.table;
      }

      batch.push(entry.row);
    }

    await flush();
    await backfillRowsFromOlderBackup(client, backupMigrations);

    const revoked = await revokeRestoredCredentials(client);

    await client.query("COMMIT");

    return { revoked, rows: counts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Backfills a migration makes on the rows it finds. Restore applies the
 * migrations to an empty database first, so when a backup was made before
 * one of these, its rows arrive after the backfill ran and are filled here
 * instead. Each runs only when the backup lacks its migration.
 */
const BACKFILLS_FOR_OLDER_BACKUPS: { migration: string; sql: string }[] = [
  {
    // Confirmations made before the confirmed name and address were kept
    // were of the account as it was then (see that migration).
    migration: "20261120100000_identity_verified_snapshot",
    sql: `
      UPDATE "user"
      SET
        identity_verified_name = name,
        identity_verified_email = email
      WHERE identity_verified_at IS NOT NULL
        AND identity_verified_name IS NULL
    `,
  },
];

export async function backfillRowsFromOlderBackup(
  client: Pick<DbPool, "query">,
  backupMigrations: ReadonlySet<string>,
) {
  for (const backfill of BACKFILLS_FOR_OLDER_BACKUPS) {
    if (!backupMigrations.has(backfill.migration)) {
      await client.query(backfill.sql);
    }
  }
}

export type RevokedCredentials = {
  providerSessions: number;
  sessions: number;
  signingLinks: number;
  verifications: number;
};

/**
 * Ends every credential a restore brought back from the backup, inside the
 * restore's own transaction. A backup holds them as they were when it was
 * made: a session signed out or ended by an administrator since, a signing
 * link spent or replaced since, a password reset already used. Brought back
 * as they were, they would work again. So after a restore:
 *
 * - everyone signs in again (sessions, and the one-time codes and links in
 *   verification, go);
 * - every signing link and emailed signing code stops working, and a
 *   signer still to sign gets a new link from the sender's reminder (the
 *   reminder's wait starts over, so one can go at once), or, on an
 *   embedded envelope, from the app asking the API for a new link;
 * - a signature that was under way at a signing provider has to be started
 *   again.
 *
 * The rate limit counts go too: they are kept for minutes, not as records.
 * Download links for finished documents are kept: nothing ends them early,
 * so the backup's are the same as the live ones were.
 */
export async function revokeRestoredCredentials(
  client: Pick<DbPool, "query">,
): Promise<RevokedCredentials> {
  const sessions = await client.query(`DELETE FROM session`);
  const verifications = await client.query(`DELETE FROM verification`);

  await client.query(`DELETE FROM rate_limits`);

  const signingLinks = await client.query(
    `
      UPDATE signers
      SET
        signing_token_hash = NULL,
        signing_token_expires_at = NULL,
        email_code_hash = NULL,
        email_code_expires_at = NULL,
        -- The sender's reminder is how the signer gets a new link, so a
        -- reminder sent just before the backup must not hold it back.
        last_nudged_at = CASE
          WHEN signing_token_hash IS NOT NULL THEN NULL
          ELSE last_nudged_at
        END
      WHERE signing_token_hash IS NOT NULL OR email_code_hash IS NOT NULL
    `,
  );
  const providerSessions = await client.query(
    `
      UPDATE provider_signing_sessions
      SET state = 'failed', secret_data = ''
      WHERE state IN ('pending', 'signing')
    `,
  );

  return {
    providerSessions: providerSessions.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0,
    signingLinks: signingLinks.rowCount ?? 0,
    verifications: verifications.rowCount ?? 0,
  };
}

/** Copies the backed-up files into the install's store, at their own paths. */
export async function restoreFiles({
  source,
  target,
}: {
  source: BackupStore;
  target: BackupStore;
}): Promise<{ copied: number; failures: string[]; skipped: number }> {
  const copies = await listAll(source, FILES_PREFIX);
  // A file already there at the same size was copied by an earlier run that
  // stopped part way, so running it again carries on from there.
  const present = new Map(
    (await listAll(target)).map((blob) => [blob.pathname, blob.size]),
  );
  const failures: string[] = [];
  let copied = 0;
  let skipped = 0;

  for (const copy of copies) {
    if (present.get(copy.pathname.slice(FILES_PREFIX.length)) === copy.size) {
      skipped += 1;
      continue;
    }

    let found: Awaited<ReturnType<BackupStore["get"]>> = null;

    try {
      found = await source.get(copy.pathname);

      if (!found) {
        failures.push(copy.pathname);
        continue;
      }

      await target.put(copy.pathname.slice(FILES_PREFIX.length), found.stream, {
        contentType: found.contentType,
      });
      copied += 1;
    } catch {
      await discardStream(found?.stream);
      failures.push(copy.pathname);
    }
  }

  return { copied, failures, skipped };
}
