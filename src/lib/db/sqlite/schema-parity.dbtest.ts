import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runMigrations } from "../../../../db/migrate.mjs";
import { openSqliteDatabase } from "./open.ts";
import { openTestDatabase } from "../test-database.ts";
import { isSqliteUrl } from "./pool.ts";

// The SQLite schema (db/sqlite) matches the Postgres one (db/migrations):
// the same tables, the same columns, the same kind of type and the same
// nullability. Needs Postgres, so it runs in the Postgres test:db job; the
// SQLite job has no Postgres to compare with.

const POSTGRES_TYPES: Record<string, string> = {
  ARRAY: "array",
  bigint: "integer",
  boolean: "boolean",
  bytea: "bytes",
  integer: "integer",
  jsonb: "json",
  real: "real",
  smallint: "integer",
  text: "text",
  "timestamp with time zone": "timestamp",
};

const SQLITE_TYPES: Record<string, string> = {
  BIGINT: "integer",
  BOOLEAN: "boolean",
  BYTEA: "bytes",
  INTEGER: "integer",
  JSONB: "json",
  REAL: "real",
  SMALLINT: "integer",
  TEXT: "text",
  "TEXT[]": "array",
  TIMESTAMPTZ: "timestamp",
};

type Shape = Record<string, string>;

test(
  "the SQLite schema has the tables and columns of the Postgres one",
  {
    skip: isSqliteUrl(process.env.E2E_DATABASE_URL) ? "needs Postgres" : false,
  },
  async () => {
    const postgres = await openTestDatabase();
    const expected: Shape = {};
    const actual: Shape = {};

    try {
      const columns = await postgres.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        table_name: string;
      }>(
        `select c.table_name, c.column_name, c.data_type, c.is_nullable
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`,
      );

      for (const column of columns.rows) {
        expected[`${column.table_name}.${column.column_name}`] =
          `${POSTGRES_TYPES[column.data_type] ?? column.data_type} ${column.is_nullable === "NO" ? "not null" : "null"}`;
      }
    } finally {
      await postgres.end();
    }

    const directory = mkdtempSync(path.join(tmpdir(), "signudoc-parity-"));
    const connectionString = `sqlite:${path.join(directory, "parity.db")}`;

    try {
      await runMigrations({ connectionString, log: () => undefined });

      const database = openSqliteDatabase(connectionString);

      try {
        const tables = database
          .prepare(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
          )
          .all() as { name: string }[];

        for (const { name } of tables) {
          const columns = database
            .prepare(`pragma table_info("${name}")`)
            .all() as {
            name: string;
            notnull: number;
            type: string;
          }[];

          for (const column of columns) {
            const type = column.type.toUpperCase();

            actual[`${name}.${column.name}`] =
              `${SQLITE_TYPES[type] ?? type} ${column.notnull ? "not null" : "null"}`;
          }
        }
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }

    assert.deepEqual(actual, expected);
  },
);
