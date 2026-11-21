import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { listMigrationFiles } from "../migrate.mjs";
import {
  listSqliteMigrationFiles,
  readBaselineVersions,
  runSqliteMigrations,
} from "./migrate.mjs";
import { isSqliteUrl, openSqliteDatabase, sqliteFilePath } from "./open.mjs";

// Every schema change needs a Postgres migration (db/migrations) and a
// SQLite one with the same name (db/sqlite/migrations), unless the SQLite
// baseline already stands for it. See docs/design/database-backends.md.

test("every Postgres migration has a SQLite counterpart", async () => {
  const postgres = (await listMigrationFiles()).map((file) =>
    file.replace(/\.sql$/, ""),
  );
  const baseline = new Set(await readBaselineVersions());
  const sqlite = new Set(
    (await listSqliteMigrationFiles()).map((file) =>
      file.replace(/\.sql$/, ""),
    ),
  );
  const missing = postgres.filter(
    (version) => !baseline.has(version) && !sqlite.has(version),
  );

  assert.deepEqual(
    missing,
    [],
    "Add the SQLite version of each to db/sqlite/migrations, with the same file name.",
  );
});

test("the SQLite side names no migration Postgres does not have", async () => {
  const postgres = new Set(
    (await listMigrationFiles()).map((file) => file.replace(/\.sql$/, "")),
  );
  const strays = [
    ...(await readBaselineVersions()),
    ...(await listSqliteMigrationFiles()).map((file) =>
      file.replace(/\.sql$/, ""),
    ),
  ].filter((version) => !postgres.has(version));

  assert.deepEqual(strays, []);
});

test("a baseline version has no SQLite migration as well", async () => {
  const baseline = new Set(await readBaselineVersions());
  const both = (await listSqliteMigrationFiles())
    .map((file) => file.replace(/\.sql$/, ""))
    .filter((version) => baseline.has(version));

  assert.deepEqual(both, []);
});

test("migrating applies everything once, and records the Postgres names", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "signudoc-sqlite-migrate-"),
  );
  const connectionString = `sqlite:${path.join(directory, "m.db")}`;

  try {
    const first = await runSqliteMigrations({
      connectionString,
      log: () => {},
    });
    const second = await runSqliteMigrations({
      connectionString,
      log: () => {},
    });

    assert.ok(first.applied.length > 0);
    assert.deepEqual(second.applied, []);

    const database = openSqliteDatabase(connectionString);

    try {
      const recorded = database
        .prepare("select version from signudoc_migrations order by version")
        .all()
        .map((row) => row.version);
      const expected = [
        ...(await readBaselineVersions()),
        ...(await listSqliteMigrationFiles()).map((file) =>
          file.replace(/\.sql$/, ""),
        ),
      ].sort();

      assert.deepEqual(recorded, expected);
      assert.equal(
        database.prepare("pragma journal_mode").get().journal_mode,
        "wal",
      );
      assert.equal(
        database.prepare("pragma foreign_keys").get().foreign_keys,
        1,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("sqlite: connection strings name a file", () => {
  assert.equal(isSqliteUrl("sqlite:/data/x.db"), true);
  assert.equal(isSqliteUrl("postgres://a@b/c"), false);
  assert.equal(sqliteFilePath("sqlite:/data/x.db"), "/data/x.db");
  assert.equal(sqliteFilePath("sqlite:///data/x.db"), "/data/x.db");
  assert.equal(sqliteFilePath("sqlite:rel/x.db"), path.resolve("rel/x.db"));
});

test("the app's copy of open.mjs reads sqlite: URLs the same way", async () => {
  const copy = await import("../../src/lib/db/sqlite/open.ts");

  for (const url of [
    "sqlite:/data/x.db",
    "sqlite:///data/x.db",
    "sqlite:rel/x.db",
    "SQLITE:/data/a%20b.db?mode=rw",
    "postgres://a@b/c",
  ]) {
    assert.equal(copy.isSqliteUrl(url), isSqliteUrl(url), url);

    if (isSqliteUrl(url)) {
      assert.equal(copy.sqliteFilePath(url), sqliteFilePath(url), url);
    }
  }
});
