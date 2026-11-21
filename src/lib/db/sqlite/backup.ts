// SignuDoc's own backup (src/lib/backup.ts) on the SQLite backend: the same
// NDJSON export, with every value in the JSON form Postgres's row_to_json
// gives it, so a backup from either backend restores into either. See
// docs/design/database-backends.md, "Backups".
import type { DatabaseSync } from "node:sqlite";

import { openSqliteDatabase } from "./open.ts";
import { formatTimestamp } from "./functions.ts";
import type { DbPool } from "../connection.ts";
import type { SqlitePool } from "./pool.ts";

type Column = { name: string; type: string };

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function columnsOf(database: DatabaseSync, table: string): Column[] {
  return (
    database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as {
      name: string;
      type: string;
    }[]
  ).map(({ name, type }) => ({ name, type: type.toUpperCase() }));
}

/** The tables, in an order that inserts parents before children. */
export function listSqliteTablesInRestoreOrder(
  database: DatabaseSync,
): string[] {
  const tables = (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map(({ name }) => name);
  const parents = new Map<string, Set<string>>();

  for (const table of tables) {
    const references = database
      .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
      .all() as { table: string }[];

    parents.set(
      table,
      new Set(
        references
          .map((reference) => reference.table)
          .filter((name) => name !== table),
      ),
    );
  }

  const ordered: string[] = [];
  const placed = new Set<string>();

  while (ordered.length < tables.length) {
    const ready = tables.filter(
      (name) =>
        !placed.has(name) &&
        [...(parents.get(name) ?? [])].every(
          (parent) => placed.has(parent) || !parents.has(parent),
        ),
    );
    const next =
      ready.length > 0 ? ready : tables.filter((name) => !placed.has(name));

    for (const name of next) {
      placed.add(name);
      ordered.push(name);
    }
  }

  return ordered;
}

/** A stored value as Postgres's row_to_json writes the same column. */
function toBackupValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (type.includes("BOOL")) {
    return Number(value) !== 0;
  }

  if (type.includes("JSON") || type.endsWith("[]")) {
    return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  }

  if (value instanceof Uint8Array) {
    return `\\x${Buffer.from(value).toString("hex")}`;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return value;
}

/** A value from a backup (either backend's) as SQLite stores it. */
function fromBackupValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (type.includes("BOOL")) {
    return value === true || value === "true" || value === 1 ? 1 : 0;
  }

  if (type.includes("JSON") || type.endsWith("[]")) {
    return JSON.stringify(value);
  }

  if (type.startsWith("TIMESTAMP")) {
    // Postgres writes 2026-01-02T03:04:05.123456+00:00; stored here in the
    // one fixed format, so text order stays time order.
    return formatTimestamp(new Date(String(value)));
  }

  if (type === "BYTEA" || type === "BLOB") {
    const text = String(value);

    return text.startsWith("\\x")
      ? Buffer.from(text.slice(2), "hex")
      : Buffer.from(text, "base64");
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

/**
 * The database as NDJSON lines: a header, then one line per row. Read on a
 * connection of its own in one read transaction, so the tables agree with
 * each other and nobody waits for the export.
 */
export async function* exportSqliteDatabaseLines(
  pool: SqlitePool,
  header: {
    createdAt: Date;
    format: string;
    migrationsTable: string;
    version: number;
  },
): AsyncGenerator<string> {
  const database = openSqliteDatabase(pool.options.connectionString, {
    readOnly: true,
  });

  try {
    database.exec("BEGIN");

    const tables = listSqliteTablesInRestoreOrder(database);
    const migrations = tables.includes(header.migrationsTable)
      ? (
          database
            .prepare(
              `SELECT version FROM ${quoteIdentifier(header.migrationsTable)} ORDER BY version`,
            )
            .all() as { version: string }[]
        ).map(({ version }) => version)
      : [];

    yield `${JSON.stringify({
      createdAt: header.createdAt.toISOString(),
      format: header.format,
      migrations,
      tables,
      version: header.version,
    })}\n`;

    for (const table of tables) {
      if (table === header.migrationsTable) {
        continue;
      }

      const columns = columnsOf(database, table);

      for (const row of database
        .prepare(`SELECT * FROM ${quoteIdentifier(table)}`)
        .iterate()) {
        const record: Record<string, unknown> = {};

        for (const { name, type } of columns) {
          record[name] = toBackupValue(
            (row as Record<string, unknown>)[name],
            type,
          );
        }

        yield `{"table":${JSON.stringify(table)},"row":${JSON.stringify(record)}}\n`;
      }
    }

    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

export type BackupEntry =
  | { header: { migrations: string[]; tables: string[] }; kind: "header" }
  | { kind: "row"; row: unknown; table: string };

/**
 * Loads backup rows into an empty SQLite database, in one transaction:
 * all of them, or none. `finish` runs last, in the same transaction, with
 * the migrations the backup was made at (src/lib/backup.ts fills in what an
 * older backup lacks and ends the credentials it brought back).
 */
export async function restoreIntoSqlite<Finished>({
  applied,
  entries,
  fail,
  finish,
  migrationsTable,
  pool,
}: {
  applied: Set<string>;
  entries: AsyncIterable<BackupEntry>;
  fail: (message: string) => Error;
  finish: (
    client: Pick<DbPool, "query">,
    backupMigrations: ReadonlySet<string>,
  ) => Promise<Finished>;
  migrationsTable: string;
  pool: SqlitePool;
}): Promise<{ finished: Finished; rows: Record<string, number> }> {
  const client = await pool.connect();
  const counts: Record<string, number> = {};
  const columnsByTable = new Map<string, Map<string, string>>();
  let backupMigrations = new Set<string>();

  const columns = async (table: string) => {
    let found = columnsByTable.get(table);

    if (!found) {
      const result = await client.queryRaw(
        `SELECT name, type FROM pragma_table_info(?)`,
        [table],
      );

      found = new Map(
        result.rows.map((row) => [
          String(row.name),
          String(row.type).toUpperCase(),
        ]),
      );
      columnsByTable.set(table, found);
    }

    return found;
  };

  try {
    await client.query("BEGIN");
    // Rows go in table by table; the keys between them hold by the end.
    await client.queryRaw("PRAGMA defer_foreign_keys = ON", []);

    for await (const entry of entries) {
      if (entry.kind === "header") {
        const missing = entry.header.migrations.filter(
          (version) => !applied.has(version),
        );

        if (missing.length > 0) {
          throw fail(
            `The backup is from a newer version of SignuDoc. Update this copy first; it lacks ${missing.join(", ")}.`,
          );
        }

        backupMigrations = new Set(entry.header.migrations);

        // A new install can already have a row or two of its own (a seal
        // key, its settings). The backup's take their place.
        for (const table of [...entry.header.tables].reverse()) {
          if (table !== migrationsTable) {
            await client.queryRaw(`DELETE FROM ${quoteIdentifier(table)}`, []);
          }
        }

        continue;
      }

      const known = await columns(entry.table);
      const row = entry.row as Record<string, unknown>;
      // Only the columns the backup has, so a column added by a newer
      // migration gets its default.
      const names = Object.keys(row).filter((name) => known.has(name));

      await client.queryRaw(
        `INSERT INTO ${quoteIdentifier(entry.table)} (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        names.map((name) => fromBackupValue(row[name], known.get(name)!)),
      );
      counts[entry.table] = (counts[entry.table] ?? 0) + 1;
    }

    const finished = await finish(
      client as unknown as Pick<DbPool, "query">,
      backupMigrations,
    );

    await client.query("COMMIT");

    return { finished, rows: counts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
