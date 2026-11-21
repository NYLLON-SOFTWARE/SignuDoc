import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CATALOG_VIEWS_SQL, registerFunctions } from "./functions.ts";
import { rewriteSql, UnsupportedSqlError } from "./rewrite.ts";
import { readSchemaInfo } from "./schema.ts";
import { collectSqlCorpus } from "./sql-corpus.ts";
import { POSTGRES_ONLY, STAND_INS } from "./sql-corpus-exceptions.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** A database with the SQLite schema (the baseline and the migrations after it), as the app opens one. */
function baselineDatabase() {
  const database = new DatabaseSync(":memory:");

  registerFunctions(database, {
    lockWaiters: () => 0,
    now: () => new Date().toISOString(),
  });
  database.exec(
    readFileSync(path.join(root, "db/sqlite/baseline.sql"), "utf8"),
  );

  const migrations = path.join(root, "db/sqlite/migrations");

  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(migrations, file), "utf8");
    // As db/sqlite/migrate.mjs runs one that makes a table again.
    const rebuildsTables = /^-- sqlite: rebuilds tables$/m.test(sql);

    if (rebuildsTables) {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("PRAGMA legacy_alter_table = ON");
    }

    database.exec(sql);

    if (rebuildsTables) {
      database.exec("PRAGMA legacy_alter_table = OFF");
      database.exec("PRAGMA foreign_keys = ON");
    }
  }

  database.exec(
    "create table signudoc_migrations (version text primary key, applied_at timestamptz not null)",
  );
  database.exec(CATALOG_VIEWS_SQL);

  return database;
}

const database = baselineDatabase();
const schema = readSchemaInfo(database);

function sqlite(sql: string) {
  return rewriteSql(sql, schema).sql;
}

test("every SQL statement in the app runs on SQLite", () => {
  const corpus = collectSqlCorpus(root);
  const failures: string[] = [];
  const usedStandIns = new Set<string>();
  const usedExceptions = new Set<string>();

  // Not a vacuous pass: the app sends hundreds of statements.
  assert.ok(
    corpus.length > 250,
    `only ${String(corpus.length)} statements found`,
  );

  for (const entry of corpus) {
    const where = `${entry.file}:${String(entry.line)}`;

    entry.standIns.forEach((standIn) => usedStandIns.add(standIn));

    const exception = POSTGRES_ONLY.find(
      (candidate) =>
        candidate.file === entry.file && entry.sql.includes(candidate.contains),
    );

    if (exception) {
      usedExceptions.add(`${exception.file}|${exception.contains}`);
      continue;
    }

    if (entry.unresolved.length > 0) {
      failures.push(
        `${where}: cannot work out ${entry.unresolved.map((text) => `\${${text}}`).join(", ")}. Add a stand-in to src/lib/db/sqlite/sql-corpus-exceptions.ts.`,
      );
      continue;
    }

    try {
      const rewritten = rewriteSql(entry.sql, schema);

      if (
        rewritten.kind === "begin" ||
        rewritten.kind === "commit" ||
        rewritten.kind === "rollback"
      ) {
        continue;
      }

      // Preparing checks the syntax, every table, column and function, and
      // that each ON CONFLICT target is a unique index.
      for (const step of rewritten.preSteps ?? []) {
        database.prepare(step.sql);
      }

      database.prepare(rewritten.sql);
    } catch (error) {
      failures.push(
        `${where}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const key of Object.keys(STAND_INS)) {
    if (!usedStandIns.has(key)) {
      failures.push(
        `The stand-in for \${${key}} is used by no statement any more. Remove it.`,
      );
    }
  }

  for (const exception of POSTGRES_ONLY) {
    if (!usedExceptions.has(`${exception.file}|${exception.contains}`)) {
      failures.push(
        `The Postgres-only entry for ${exception.file} (${exception.contains}) matches nothing any more. Remove it.`,
      );
    }
  }

  assert.deepEqual(failures, []);
});

test("parameters are numbered, so one used twice binds once", () => {
  assert.equal(sqlite("SELECT $1, $2, $1"), "SELECT ?1, ?2, ?1");
});

test("public. is dropped from table names, nowhere else", () => {
  assert.equal(
    sqlite(`SELECT 'public.x' FROM public."user" u WHERE u.id = $1`),
    `SELECT 'public.x' FROM "user" u WHERE u.id = ?1`,
  );
});

test("to_regclass tells whether a table exists", () => {
  const exists = (name: string) =>
    database
      .prepare(sqlite(`SELECT to_regclass('${name}') IS NOT NULL AS present`))
      .get() as { present: number };

  assert.equal(exists("envelopes").present, 1);
  assert.equal(exists("public.envelopes").present, 1);
  assert.equal(exists("no_such_table").present, 0);
});

test("casts keep their Postgres meaning", () => {
  assert.equal(
    sqlite("SELECT count(*)::int AS n FROM envelopes"),
    "SELECT pg_int(count(*)) AS n FROM envelopes",
  );
  assert.equal(
    sqlite("SELECT $1::bigint + $2::bigint"),
    "SELECT pg_int(?1) + pg_int(?2)",
  );
  // Named after the column, as Postgres names it.
  assert.equal(
    sqlite("SELECT id::text FROM envelopes"),
    'SELECT CAST(id AS TEXT) AS "id" FROM envelopes',
  );
  assert.equal(
    sqlite("SELECT e.id::text AS ref FROM envelopes e"),
    "SELECT CAST(e.id AS TEXT) AS ref FROM envelopes e",
  );
  assert.equal(sqlite("SELECT '{}'::jsonb, $1::text[]"), "SELECT '{}', ?1");
  assert.equal(
    sqlite(
      "SELECT count(*) FILTER (WHERE status = 'sent')::int AS n FROM envelopes",
    ),
    "SELECT pg_int(count(*) FILTER(WHERE status = 'sent')) AS n FROM envelopes",
  );
  assert.equal(
    sqlite("SELECT x::text::int FROM t"),
    "SELECT pg_int(CAST(x AS TEXT)) FROM t",
  );
  assert.equal(sqlite("SELECT 'a::b'"), "SELECT 'a::b'");
  assert.throws(() => sqlite("SELECT 'x'::regclass"), UnsupportedSqlError);
});

test("row locks are removed, every form of them", () => {
  for (const clause of [
    "FOR UPDATE",
    "FOR UPDATE OF e",
    "FOR UPDATE OF e, s SKIP LOCKED",
    "FOR NO KEY UPDATE",
    "FOR SHARE OF u",
    "FOR KEY SHARE NOWAIT",
  ]) {
    assert.equal(
      sqlite(`SELECT id FROM envelopes e WHERE id = $1 ${clause}`),
      "SELECT id FROM envelopes e WHERE id = ?1",
    );
  }
});

test("= ANY and <> ALL read a JSON array", () => {
  assert.equal(
    sqlite("SELECT id FROM signers WHERE id = ANY($1::text[])"),
    "SELECT id FROM signers WHERE id IN(SELECT value FROM json_each(?1))",
  );
  assert.equal(
    sqlite("SELECT id FROM signers WHERE id <> ALL($1)"),
    "SELECT id FROM signers WHERE id NOT IN(SELECT value FROM json_each(?1))",
  );
  assert.equal(
    sqlite("SELECT 1 WHERE 'a' = ANY(SELECT id FROM signers)"),
    "SELECT 1 WHERE 'a' IN(SELECT id FROM signers)",
  );
});

test("dates: EXTRACT, intervals, now()", () => {
  assert.equal(
    sqlite("SELECT extract(epoch from now())::int - 3600"),
    "SELECT pg_int(pg_epoch(now())) - 3600",
  );
  assert.equal(
    sqlite(`UPDATE session SET "expiresAt" = now() - interval '1 minute'`),
    `UPDATE session SET "expiresAt" = pg_interval_add(now(), '1 minute', -1)`,
  );
  assert.equal(sqlite("SELECT CURRENT_TIMESTAMP"), "SELECT now()");
});

test("special forms: position, substring, unnest, generate_series, ARRAY", () => {
  assert.equal(
    sqlite("SELECT position($1 in lower(name)) FROM t"),
    "SELECT instr(lower(name), ?1) FROM t",
  );
  assert.equal(
    sqlite("SELECT substring(email from '@([^@]+)$') FROM t"),
    "SELECT pg_regexp_substring(email, '@([^@]+)$') FROM t",
  );
  assert.equal(
    sqlite("SELECT substring(x from 2 for 3) FROM t"),
    "SELECT substr(x, 2, 3) FROM t",
  );
  assert.equal(
    sqlite("SELECT key FROM unnest($1::text[]) AS key"),
    "SELECT key FROM(SELECT value AS key FROM json_each(?1)) AS key",
  );
  assert.match(
    sqlite("SELECT 1 FROM unnest($1::int[]) AS skipped(row_number)"),
    /\(SELECT value AS row_number FROM json_each\(\?1\)\) AS skipped$/,
  );
  assert.match(
    sqlite("SELECT n FROM generate_series(1, $2::int) as n"),
    /WITH RECURSIVE _series/,
  );
  assert.equal(
    sqlite("SELECT ARRAY(SELECT id FROM signers ORDER BY id) AS ids"),
    "SELECT(SELECT json_group_array(id ORDER BY id) FROM signers) AS ids",
  );
  assert.equal(sqlite("SELECT ARRAY[$1, $2]"), "SELECT json_array(?1, ?2)");
});

test("UPDATE and DELETE aliases, and FROM tables in RETURNING", () => {
  assert.equal(
    sqlite("DELETE FROM pending_file_deletions p WHERE p.storage_key = $1"),
    "DELETE FROM pending_file_deletions AS p WHERE p.storage_key = ?1",
  );
  assert.equal(
    sqlite(
      "UPDATE scheduled_envelope_deletions x SET last_attempt_at = 0 FROM envelopes e WHERE x.envelope_id = $1 AND e.id = x.envelope_id RETURNING e.title",
    ),
    `UPDATE scheduled_envelope_deletions AS x SET last_attempt_at = 0 FROM envelopes e WHERE x.envelope_id = ?1 AND e.id = x.envelope_id RETURNING(SELECT e.title FROM envelopes e WHERE(e.id = scheduled_envelope_deletions.envelope_id) LIMIT 1) AS "title"`,
  );
  assert.equal(
    sqlite(
      "UPDATE pending_file_deletions p SET last_tried_at = 1 WHERE p.storage_key = $1 RETURNING p.storage_key",
    ),
    "UPDATE pending_file_deletions AS p SET last_tried_at = 1 WHERE p.storage_key = ?1 RETURNING pending_file_deletions.storage_key",
  );
});

test("ON CONFLICT ON CONSTRAINT names the constraint's columns", () => {
  assert.match(
    sqlite(
      "INSERT INTO recipient_download_tokens (token_hash) VALUES ($1) ON CONFLICT ON CONSTRAINT recipient_download_tokens_signer_file_unique DO NOTHING",
    ),
    /ON CONFLICT\("envelope_id", "signer_id", "file_type"\) DO NOTHING/,
  );
});

test("INSERT … SELECT … ON CONFLICT gets the WHERE SQLite's grammar needs", () => {
  assert.equal(
    sqlite(
      "INSERT INTO rate_limits (key, count, expires_at) SELECT key, 1, 2 FROM t ON CONFLICT (key) DO NOTHING",
    ),
    "INSERT INTO rate_limits(key, count, expires_at) SELECT key, 1, 2 FROM t WHERE true ON CONFLICT(key) DO NOTHING",
  );
});

test("DELETE … USING deletes the rows the other tables match", () => {
  const scratch = new DatabaseSync(":memory:");

  scratch.exec(`
    create table t (id integer primary key, kind text);
    create table u (id integer primary key, flag integer);
    insert into t values (1, 'a'), (2, 'a'), (3, 'b'), (4, 'a');
    insert into u values (1, 1), (2, 0), (3, 1);
  `);
  scratch.exec(
    sqlite(
      "DELETE FROM t x USING u y WHERE y.id = x.id AND y.flag = 1 AND x.kind = 'a'",
    ),
  );

  assert.deepEqual(
    scratch
      .prepare("select id from t order by id")
      .all()
      .map((row) => row.id),
    [2, 3, 4],
  );

  // With no WHERE, every row goes while u has any.
  scratch.exec(sqlite("DELETE FROM t USING u"));
  assert.deepEqual(scratch.prepare("select id from t").all(), []);
});

test("TRUNCATE is a DELETE", () => {
  assert.equal(sqlite(`truncate public."user" cascade`), `DELETE FROM "user"`);
});

test("a data-modifying WITH runs as two statements", () => {
  const rewritten = rewriteSql(
    `WITH removed AS (DELETE FROM templates WHERE id = $1 AND user_id = $2 RETURNING user_id) SELECT u.name FROM removed JOIN "user" u ON u.id = removed.user_id`,
    schema,
  );

  assert.deepEqual(rewritten.preSteps, [
    {
      parameters: 2,
      rowsParameter: 3,
      sql: "DELETE FROM templates WHERE id = ?1 AND user_id = ?2 RETURNING user_id",
    },
  ]);
  assert.equal(rewritten.parameters, 3);
  assert.match(
    rewritten.sql,
    /WITH removed\("user_id"\) AS\(SELECT json_extract\(value, '\$\[0\]'\) FROM json_each\(\?3\)\)/,
  );
});

test("a WITH that modifies data in several parts runs them in order", () => {
  // Each part reads the rows of the parts before it; one with no RETURNING
  // only runs.
  const rewritten = rewriteSql(
    `WITH claim AS (UPDATE bulk_send_batches SET claimed_at = 1 WHERE id = $1 AND claim_token = $3 RETURNING id), inserted AS (INSERT INTO bulk_send_batch_rows (batch_id, row_number, status) SELECT claim.id, skipped.row_number, 'skipped' FROM claim CROSS JOIN unnest($2::int[]) AS skipped(row_number) ON CONFLICT (batch_id, row_number) DO NOTHING) SELECT id FROM claim`,
    schema,
  );

  assert.deepEqual(
    rewritten.preSteps?.map(({ parameters, rowsParameter }) => ({
      parameters,
      rowsParameter,
    })),
    [
      { parameters: 3, rowsParameter: 4 },
      { parameters: 4, rowsParameter: null },
    ],
  );
  assert.match(rewritten.preSteps![1]!.sql, /^WITH claim\("id"\) AS/);
  assert.match(
    rewritten.preSteps![1]!.sql,
    /\(SELECT value AS row_number FROM json_each\(\?2\)\) AS skipped WHERE true ON CONFLICT/,
  );
  assert.equal(rewritten.parameters, 4);
  assert.match(rewritten.sql, /SELECT id FROM claim$/);

  // A plain part before the one that writes goes with it; RETURNING x.*
  // names the table's columns.
  const claimed = rewriteSql(
    `WITH due AS (SELECT d.id FROM webhook_deliveries d WHERE d.next_attempt_at <= $1 FOR UPDATE OF d SKIP LOCKED), claimed AS (UPDATE webhook_deliveries d SET attempts = d.attempts + 1 FROM due WHERE d.id = due.id RETURNING d.*) SELECT c.id, c.attempts FROM claimed c`,
    schema,
  );

  assert.match(claimed.preSteps![0]!.sql, /^WITH due AS/);
  assert.match(claimed.preSteps![0]!.sql, /RETURNING webhook_deliveries\.id,/);
  assert.match(claimed.sql, /claimed\("id", "endpoint_id",/);

  for (const step of [
    ...(rewritten.preSteps ?? []),
    ...(claimed.preSteps ?? []),
  ]) {
    database.prepare(step.sql);
  }

  database.prepare(rewritten.sql);
  database.prepare(claimed.sql);
});

test("LOCK TABLE takes the write lock", () => {
  const rewritten = rewriteSql(
    "LOCK TABLE webhook_endpoints IN SHARE ROW EXCLUSIVE MODE",
    schema,
  );

  assert.equal(rewritten.kind, "locking-read");
  database.prepare(rewritten.sql);
});

test("a part of a compound SELECT in parentheses becomes a subquery", () => {
  const rewritten = sqlite(
    "SELECT id FROM api_keys WHERE revoked_at IS NULL UNION ALL (SELECT id FROM api_keys ORDER BY revoked_at DESC LIMIT $1)",
  );

  assert.match(
    rewritten,
    /UNION ALL SELECT \* FROM ?\(SELECT id FROM api_keys ORDER BY revoked_at DESC LIMIT \?1\)$/,
  );
  database.prepare(rewritten);
});

test("advisory locks are recognized, with their key expression", () => {
  const blocking = rewriteSql(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 7))",
  );
  const attempt = rewriteSql("select pg_try_advisory_xact_lock($1) as locked");

  assert.equal(blocking.kind, "advisory");
  assert.equal(blocking.sql, "SELECT hashtextextended(?1, 7)");
  assert.deepEqual(blocking.advisory, {
    column: "pg_advisory_xact_lock",
    isTry: false,
  });
  assert.deepEqual(attempt.advisory, { column: "locked", isTry: true });
});

test("statements are classified: reads go to the reader, the rest take the write lock", () => {
  assert.equal(rewriteSql("SELECT 1").kind, "read");
  assert.equal(rewriteSql("WITH x AS (SELECT 1) SELECT * FROM x").kind, "read");
  assert.equal(
    rewriteSql("WITH x AS (SELECT 1) UPDATE t SET a = 1").kind,
    "write",
  );
  assert.equal(rewriteSql("UPDATE t SET a = 1").kind, "write");
  assert.equal(
    rewriteSql("SELECT a FROM t WHERE id = $1 FOR UPDATE").kind,
    "locking-read",
  );
  assert.equal(
    rewriteSql("SELECT a / b FROM t").sql,
    "SELECT a / pg_nonzero(b) FROM t",
  );
  assert.equal(
    rewriteSql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").kind,
    "begin",
  );
  assert.equal(rewriteSql("commit").kind, "commit");
  assert.equal(rewriteSql("ROLLBACK").kind, "rollback");
});

test("computed columns are given the type Postgres would return", () => {
  const hints = (sql: string) =>
    Object.fromEntries(rewriteSql(sql, schema).hints);

  assert.deepEqual(
    hints(
      `SELECT EXISTS (SELECT 1 FROM signers) AS "hasSigners", count(*) AS n FROM envelopes`,
    ),
    {
      hasSigners: "bool",
    },
  );
  assert.deepEqual(
    hints("SELECT a = b AS same, x IS NULL AS missing, NOT y AS no FROM t"),
    {
      missing: "bool",
      no: "bool",
      same: "bool",
    },
  );
  assert.deepEqual(
    hints(
      `SELECT jsonb_build_object('a', 1) AS o, metadata -> 'x' AS j, ARRAY(SELECT 1 FROM t) AS a FROM t`,
    ),
    {
      a: "json",
      j: "json",
      o: "json",
    },
  );
  assert.deepEqual(
    hints(
      `SELECT max("createdAt") AS latest, coalesce(part11, false) AS p FROM t`,
    ),
    {
      latest: "date",
      p: "bool",
    },
  );
  assert.deepEqual(
    hints("SELECT CASE WHEN a = 1 THEN true ELSE false END AS flag FROM t"),
    { flag: "bool" },
  );
  assert.deepEqual(hints("UPDATE t SET a = 1 RETURNING (b > 1) AS big"), {
    big: "bool",
  });
  assert.deepEqual(
    hints("SELECT $1::text AS t, metadata->>'x' AS s FROM t"),
    {},
  );
});

test("Postgres SQL with no SQLite translation fails loudly", () => {
  for (const sql of [
    "SELECT DISTINCT ON (a) a FROM t",
    "SELECT * FROM t, LATERAL (SELECT 1) x",
    "SELECT * FROM t WHERE a ILIKE $1",
    "SELECT * FROM t WHERE a ~ $1",
    "DELETE FROM t USING u WHERE t.id = u.id RETURNING u.id",
    "SELECT 1; SELECT 2",
    "SELECT $$x$$",
  ]) {
    assert.throws(() => sqlite(sql), UnsupportedSqlError, sql);
  }
});
