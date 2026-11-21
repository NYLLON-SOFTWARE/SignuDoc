# Database backends: Postgres and SQLite

SignuDoc talks to Postgres through `pg`. It can also keep its data in a SQLite file, for a small install that runs as one process on one machine and would rather not run a database server. Postgres stays the default and is unchanged: with a Postgres `DATABASE_URL` nothing in this document applies.

The priorities, in order:

1. Correctness of the signing evidence, and durability of the data.
2. As little change to the application's SQL as possible: statements are written for Postgres and run unchanged on both, with one exception (below).
3. A simple data-access layer.

## Contents

- [Choosing the backend](#choosing-the-backend)
- [Limits](#limits)
- [The executor interface](#the-executor-interface)
- [How SQLite runs Postgres SQL](#how-sqlite-runs-postgres-sql)
- [Types](#types)
- [Transactions and concurrency](#transactions-and-concurrency)
- [Schema and migrations](#schema-and-migrations)
- [Better Auth](#better-auth)
- [Backups](#backups)
- [Switching backends later](#switching-backends-later)
- [Tests and CI](#tests-and-ci)
- [Files outside the adapter](#files-outside-the-adapter)

## Choosing the backend

The backend is chosen by the connection string, nothing else:

| `DATABASE_URL`                                 | Backend            |
| ---------------------------------------------- | ------------------ |
| `postgres://…`, `postgresql://…` (and Neon's…) | Postgres (default) |
| `sqlite:/absolute/path/file.db`                | SQLite             |
| `sqlite:relative/path/file.db`                 | SQLite, from cwd   |
| `sqlite:///absolute/path/file.db`              | SQLite             |

A SQLite install also needs `BETTER_AUTH_SECRET`. On Postgres, without it the secret is derived from the database password, and a `sqlite:` URL has no password, so sign-in (including creating the first administrator) fails until it is set. Generate one with `openssl rand -hex 32` and save it as `BETTER_AUTH_SECRET` next to `DATABASE_URL`. An install moving from Postgres keeps the `BETTER_AUTH_SECRET` it already has (see [Switching backends later](#switching-backends-later)).

`db/sqlite/open.mjs` parses it and opens the file, for `db/migrate.mjs`, which runs as plain JavaScript. The app has a TypeScript copy, `src/lib/db/sqlite/open.ts`, because the end-to-end tests load the pool through Playwright, which cannot load `.mjs` files; `db/sqlite/migrations.test.mjs` checks the two agree.

SQLite is Node 24's built-in [`node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) (`DatabaseSync`). There is no native npm dependency, and `node:sqlite` is only loaded when a `sqlite:` URL is used. The parts of its API used, all present in Node 24: `new DatabaseSync(path, { timeout, readOnly, enableForeignKeyConstraints })`, `prepare()`, `StatementSync.all()/run()/columns()` (declared types of result columns), numbered parameters `?NNN`, `database.function()` for user-defined SQL functions, and `isTransaction`.

Every connection is opened with `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON` and `busy_timeout=5000`.

## Limits

- **Exactly one running instance.** The write lock, the row locks and the advisory locks that keep the jobs and the signing flow correct are held inside the one Node process (see [Transactions and concurrency](#transactions-and-concurrency)). Two app processes on the same file, a second replica, a rolling deploy that overlaps old and new, or serverless functions (Vercel) would each have their own and could corrupt the signing order and the audit chain. Run one process, stop it before starting the next, and keep the file on a disk that outlives the process.
- **No other writer.** Nothing else may write to the file while the app runs. The app defines its own `lower()` (below), and a second writer such as the `sqlite3` command line would not.
- **Durability is the disk's.** Every commit is on disk before it returns (`synchronous=FULL`), but the file is only as safe as the disk it is on. Back it up: SignuDoc's own backup works on SQLite ([Backups](#backups)).

For anything beyond one small instance, use Postgres. The [transfer script](#switching-backends-later) moves the data across.

## The executor interface

Unchanged. Call sites keep using what `src/lib/db/connection.ts` gives them:

- `getDb()` returns a pool with `query(text, params) => Promise<{ rows, rowCount }>` and `connect()`. On SQLite it is a `SqlitePool` (`src/lib/db/sqlite/pool.ts`) whose shape matches the part of `pg.Pool` the app uses (`query`, `connect`, `end`, `on`), typed as `pg.Pool` so not one type annotation at a call site changes.
- `connect()` returns a client with `query()` and `release()`.
- `withTransaction(run)`, `afterCommit()`, `queryOne()`, `queryMany()` and `replaceDbPoolForTests()` are unchanged and work on both backends, because the SQLite client understands `BEGIN`, `COMMIT` and `ROLLBACK` the way `withTransaction` sends them.

The SQL the app sends is Postgres SQL on both backends. The SQLite pool translates it (next section).

## How SQLite runs Postgres SQL

Adapter-level compatibility, not call-site edits. Two layers, in `src/lib/db/sqlite/`. No statement in the app is written differently, so Postgres runs exactly the SQL it ran before.

### 1. User-defined functions with Postgres names (`functions.ts`)

Registered on every SQLite connection the app opens:

| Postgres                                     | On SQLite                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `now()`                                      | ISO-8601 UTC text, `YYYY-MM-DDTHH:MM:SS.sssZ`. One value per statement outside a transaction and one per transaction inside one (the time `BEGIN IMMEDIATE` ran), as in Postgres. SQLite would otherwise evaluate it per row. |
| `gen_random_uuid()`                          | `crypto.randomUUID()`.                                                                                                                                                                                                        |
| `pg_advisory_xact_lock(k)`                   | Statements that only take a lock are handled by the pool itself (see [locks](#advisory-locks)). Anywhere else, a no-op.                                                                                                       |
| `pg_try_advisory_xact_lock(k)`               | As above; anywhere else returns true.                                                                                                                                                                                         |
| `hashtextextended(t, seed)`                  | A stable 52-bit hash. Only ever used as a lock key.                                                                                                                                                                           |
| `greatest(...)`, `least(...)`                | Postgres semantics: NULL arguments are ignored (SQLite's `max(a, b)` would return NULL).                                                                                                                                      |
| `left(s, n)`, `right(s, n)`                  | As in Postgres, including negative `n`.                                                                                                                                                                                       |
| `encode(b, 'hex'/'base64')`, `sha256(b)`     | As in Postgres (used by tests).                                                                                                                                                                                               |
| `jsonb_set(j, path, v)`                      | As in Postgres for object keys and array indexes.                                                                                                                                                                             |
| `cardinality(a)`, `array_length(a, 1)`       | Length of the JSON array.                                                                                                                                                                                                     |
| `date_trunc(unit, t)`                        | On ISO text and on epoch numbers.                                                                                                                                                                                             |
| `pg_epoch(t)`                                | What `EXTRACT(EPOCH FROM t)` is rewritten to.                                                                                                                                                                                 |
| `pg_interval_add(t, '±n unit')`              | What `t ± interval 'n unit'` is rewritten to.                                                                                                                                                                                 |
| `pg_int(x)`                                  | What `x::int` / `x::bigint` is rewritten to: rounds half away from zero, as a Postgres cast does (SQLite's `CAST` truncates).                                                                                                 |
| `pg_regexp_substring(s, re)`                 | What `substring(s from 'regex')` is rewritten to.                                                                                                                                                                             |
| `current_database()`, `pg_lock_waiters(...)` | For the two catalog views below.                                                                                                                                                                                              |

### 2. A mechanical rewriter for syntax SQLite lacks (`rewrite.ts`)

A small tokenizer (string literals, quoted identifiers, comments and dollar-free SQL; the app never uses `$$` in queries) and a handful of token-level rewrites. Output is cached by SQL text, so each distinct statement is rewritten once per process.

| Postgres                                                                                                                                                         | SQLite                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$1`                                                                                                                                                             | `?1` (numbered, so a parameter used twice binds once)                                                                                                                                                                   |
| `x::int`, `x::bigint`, `x::integer`                                                                                                                              | `pg_int(x)`                                                                                                                                                                                                             |
| `x::text`                                                                                                                                                        | `CAST(x AS TEXT)`                                                                                                                                                                                                       |
| `x::numeric`, `x::float8`, `x::real`, `x::double precision`                                                                                                      | `CAST(x AS REAL)`                                                                                                                                                                                                       |
| `x::jsonb`, `x::json`, `x::text[]`, `x::timestamptz`, …                                                                                                          | `x` (stored representation is already right)                                                                                                                                                                            |
| `public.table`                                                                                                                                                   | `table`                                                                                                                                                                                                                 |
| `FOR UPDATE [OF …] [SKIP LOCKED / NOWAIT]`, `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR KEY SHARE`                                                                    | removed: the whole transaction holds the write lock (below)                                                                                                                                                             |
| `x = ANY($n)`, `x = ANY(expr)`                                                                                                                                   | `x IN (SELECT value FROM json_each(expr))`, arrays travel as JSON                                                                                                                                                       |
| `x <> ALL($n)`                                                                                                                                                   | `x NOT IN (SELECT value FROM json_each(expr))`                                                                                                                                                                          |
| `unnest($n) AS a`, `unnest($n) AS a(col)`                                                                                                                        | `(SELECT value AS a FROM json_each(?n)) AS a` (`AS col` inside for the second)                                                                                                                                          |
| `ARRAY(SELECT e FROM …)`                                                                                                                                         | `(SELECT json_group_array(e) FROM …)`, ORDER BY kept inside the aggregate                                                                                                                                               |
| `ARRAY[a, b]`                                                                                                                                                    | `json_array(a, b)`                                                                                                                                                                                                      |
| `EXTRACT(EPOCH FROM x)`                                                                                                                                          | `pg_epoch(x)`                                                                                                                                                                                                           |
| `x ± interval 'n unit'`                                                                                                                                          | `pg_interval_add(x, '±n unit')`                                                                                                                                                                                         |
| `position(a IN b)`                                                                                                                                               | `instr(b, a)`                                                                                                                                                                                                           |
| `substring(s FROM 'regex')`                                                                                                                                      | `pg_regexp_substring(s, 'regex')`                                                                                                                                                                                       |
| `generate_series(a, b) AS n`                                                                                                                                     | a recursive CTE subquery named `n` with column `n`                                                                                                                                                                      |
| `row_to_json(alias)`                                                                                                                                             | `json_object('col', alias.col, …)` from the table's columns                                                                                                                                                             |
| `jsonb_build_object(…)`                                                                                                                                          | `json_object(…)`                                                                                                                                                                                                        |
| `BEGIN ISOLATION LEVEL …`, `BEGIN READ ONLY`                                                                                                                     | `BEGIN`; with `REPEATABLE READ` or `SERIALIZABLE`, its reads share one snapshot (see below)                                                                                                                             |
| `x / y`                                                                                                                                                          | `x / pg_nonzero(y)`: a division by zero is an error, as on Postgres (SQLite gives NULL)                                                                                                                                 |
| `TRUNCATE t [CASCADE]`                                                                                                                                           | `DELETE FROM t` (the foreign keys cascade)                                                                                                                                                                              |
| `UPDATE t x …`, `DELETE FROM t x …`                                                                                                                              | `… t AS x …` (SQLite needs the `AS`)                                                                                                                                                                                    |
| `RETURNING x.col` on an aliased `UPDATE`/`DELETE`                                                                                                                | `RETURNING t.col` (inside RETURNING SQLite knows the table by name only)                                                                                                                                                |
| `UPDATE … FROM f … RETURNING f.col`                                                                                                                              | `RETURNING (SELECT f.col FROM f WHERE <the WHERE's join conditions>)`                                                                                                                                                   |
| `ON CONFLICT ON CONSTRAINT name`                                                                                                                                 | `ON CONFLICT (its columns)`, read from the schema                                                                                                                                                                       |
| `INSERT … SELECT … ON CONFLICT` with no `WHERE`                                                                                                                  | `… WHERE true ON CONFLICT` (SQLite's grammar needs it)                                                                                                                                                                  |
| `WITH n AS (DELETE … RETURNING …) SELECT … FROM n`, and several such parts (`WITH a AS (UPDATE … RETURNING …), b AS (INSERT … SELECT … FROM a) SELECT … FROM a`) | one statement per data-modifying part, in order, then the rest, in one transaction; each statement after a part reads its rows from a JSON parameter. `RETURNING *` and `RETURNING x.*` are spelled out from the schema |
| `LOCK TABLE t IN … MODE`                                                                                                                                         | takes the write lock, as a locking read does: it holds back every other writer, which is what the table lock was for                                                                                                    |
| `… UNION ALL (SELECT … ORDER BY … LIMIT …)`                                                                                                                      | `… UNION ALL SELECT * FROM (SELECT … ORDER BY … LIMIT …)`: SQLite takes no parentheses around a part of a compound SELECT                                                                                               |
| `SELECT x.col::text` with no alias                                                                                                                               | `… AS col`, the name Postgres gives the column (SQLite would name it after the CAST)                                                                                                                                    |
| `DELETE FROM t x USING u y WHERE …`                                                                                                                              | `DELETE FROM t AS x WHERE EXISTS (SELECT 1 FROM u y WHERE …)`: the same rows                                                                                                                                            |

Left as they are because SQLite (3.49+ in Node 24) has them: `RETURNING`, `ON CONFLICT … DO UPDATE/NOTHING` with `EXCLUDED`, `UPDATE … FROM`, CTEs, `count(*) FILTER (WHERE …)`, `string_agg(x, sep ORDER BY …)`, `IS [NOT] DISTINCT FROM`, `NULLS FIRST/LAST`, `TRUE/FALSE`, `->` and `->>` on JSON text, `||`, `COALESCE`, `NULLIF`, `lower`, `round`, `floor`, `ceil`.

Anything the rewriter recognizes as Postgres but cannot translate (`DISTINCT ON`, `LATERAL`, `ILIKE`, `SIMILAR TO`, regex operators, `DELETE … USING … RETURNING`, `::regclass`, an unknown cast) throws `UnsupportedSqlError` naming the construct. It never passes SQL through half-translated.

**Every SQL string in the app is checked in CI.** `src/lib/db/sqlite/sql-corpus.ts` parses every non-test source file under `src/` and `scripts/` with the TypeScript compiler and collects every string or template literal that is a SQL statement. Interpolations are resolved where they are constants (same file or imported). Any other interpolation needs a stand-in in `sql-corpus-exceptions.ts` (for example the `IN` list `buildInClausePlaceholders` builds), and a statement that only ever runs on Postgres (the Postgres side of the backup) is listed there with a reason. `rewrite.test.ts` then rewrites each statement and **prepares** it against a fresh database built from the SQLite schema, which checks syntax, every table, column and function, and that each `ON CONFLICT` target matches a unique index. A stand-in or exception that no longer matches anything fails too. So a new query the rewriter cannot handle fails CI, instead of misbehaving on a SQLite install.

## Types

What the app reads must be exactly what `pg` returns (`connection.ts` sets one parser: `bigint` → `number`). Storage on SQLite:

| Postgres column type | SQLite declared type | Stored as                                                    | Read back as (same as `pg`) |
| -------------------- | -------------------- | ------------------------------------------------------------ | --------------------------- |
| `text`               | `TEXT`               | text                                                         | string                      |
| `integer`, `bigint`  | `INTEGER`, `BIGINT`  | integer                                                      | number                      |
| `real`               | `REAL`               | real                                                         | number                      |
| `boolean`            | `BOOLEAN`            | 0 / 1                                                        | boolean                     |
| `timestamptz`        | `TIMESTAMPTZ`        | text `YYYY-MM-DDTHH:MM:SS.sssZ`, so text order is time order | `Date`                      |
| `jsonb`              | `JSONB`              | JSON text                                                    | parsed value                |
| `text[]`             | `TEXT[]`             | JSON array text                                              | `string[]`                  |
| `bytea`              | `BYTEA`              | blob                                                         | `Buffer`                    |

Parameters are converted on the way in: `Date` → ISO text in that exact format, `boolean` → 0/1, arrays and plain objects → JSON text, `undefined` → NULL.

Results are converted by the declared type of each result column (`StatementSync.columns()`, which follows a column through aliases, CTEs, subqueries and `RETURNING`). Computed columns have no declared type, so the rewriter infers a type for each select-list item from its expression and the adapter applies it only when SQLite has none:

- boolean: `EXISTS`, `NOT …`, comparisons, `IS [NOT] NULL`, `IN`, `LIKE`, `BETWEEN`, `AND`/`OR`, `true`/`false`, `x::boolean`, `bool_or`/`bool_and`/`every`, the advisory-lock functions;
- JSON: `json_object`/`jsonb_build_object`, `ARRAY(…)`, `json_group_array`, `->`, `x::jsonb`, `x::text[]`, `jsonb_set`, `row_to_json` (unless cast to text);
- `Date`: `now()`, `x::timestamptz`, interval arithmetic;
- the type of the first argument for `COALESCE`, `NULLIF`, `MAX`, `MIN`, `GREATEST`, `LEAST`, and of the first `THEN` of a `CASE`, where that argument is a column whose declared type is the same in every table that has it (the adapter reads the schema once).

`count(*)` and arithmetic come back as numbers on both backends. Known differences, checked against the app and harmless there: `->>` returns a JSON number as a number where Postgres returns text (the app only reads strings this way). SQLite's own `lower()` folds ASCII only, so every connection (the app's, the read-only one, and the migrations') defines `lower()` as JavaScript's `toLowerCase`, which folds every letter as Postgres does. The unique index on a signer's address per envelope is keyed with `COLLATE NOCASE` instead of `lower(email)`, so its keys do not depend on which `lower()` a connection has.

Errors are given the Postgres `code` the app checks: `42P01` (no such table), `42703` (no such column), `23505` (unique), `23503` (foreign key), `23514` (check), `23502` (not null), `40P01` (deadlock between locks, below), `55P03` (lock timeout). `isMissingSchemaError` and `isUniqueViolation` work unchanged.

## Transactions and concurrency

One process, one writer.

- The pool holds one writer connection and one reader connection (read-only) to the same file, in WAL mode.
- **A transaction holds an in-process async mutex from its first write or locking read (`SELECT … FOR UPDATE/SHARE`) to `COMMIT`/`ROLLBACK`**, and runs `BEGIN IMMEDIATE` when it takes it. Call sites `await` between statements, so other async work runs meanwhile; the mutex makes sure none of it is a statement of another transaction. Before that point the transaction has nothing of its own: its plain reads run on the reader connection and see what is committed, exactly what a plain read in a Postgres READ COMMITTED transaction sees, and like it they lock nothing. That matters in two places: a transaction that only holds an advisory lock (the cleanup job holds one for its whole run while working through the pool) stops nobody, and first-run setup, which reads the install's state in its transaction and then creates the administrator through Better Auth before its first write, does not wait for itself.
- A transaction begun with `ISOLATION LEVEL REPEATABLE READ` or `SERIALIZABLE` (the app's read-only ones that must see one moment, such as a webhook payload's envelope and its signers) gets a read-only connection of its own and one SQLite read transaction on it: until its first write its reads see the file as it was at the first of them, as a Postgres snapshot does, and writes go on meanwhile. The connection closes with the transaction.
- A statement through the pool, outside a transaction: a write takes the mutex for that one statement; a read (`SELECT`, or `WITH` with no `INSERT`/`UPDATE`/`DELETE`) runs on the reader connection without waiting, and sees everything committed, which is what READ COMMITTED gives on Postgres. The reader is opened read-only, so a statement wrongly taken for a read fails loudly instead of writing outside the lock.
- The mutex is FIFO. A wait longer than 30 s fails with `55P03` and a message saying a transaction has held the database that long, rather than hanging: the cause would be a write through the pool from inside a transaction that has already written, which waits for itself. CI runs the database tests on SQLite to find those.
- The pool answers to `"totalCount" in database`, which is how the app tells a pool (open a transaction) from a client (already in one).

**Why stripping `FOR UPDATE` / `SKIP LOCKED` / `FOR SHARE` is safe.** On Postgres those clauses make two transactions that touch the same rows take turns at the row. Here a locking read takes the only write lock in the only process and keeps it until the transaction ends; every write and locking read of another transaction waits for it. So a row read `FOR UPDATE` cannot change until that transaction ends, which is everything `FOR UPDATE` and `FOR SHARE` promise, and there is never a locked row to skip, so `SKIP LOCKED` has nothing to do. Plain reads lock nothing, on both backends. From its first write or locking read a transaction is serializable, stronger than READ COMMITTED; code written for READ COMMITTED (retry on a lost race, re-read after a lock) stays correct.

This is why SQLite means [one running instance](#limits): the mutex and the lock table below live in the process.

### Advisory locks

`pg_advisory_xact_lock(k)` and `pg_try_advisory_xact_lock(k)` serialize the cleanup job and first-run setup, and some read-check-write sequences (role changes, the audit chains, templates, the seal key). A statement that only takes such a lock (`SELECT pg_[try_]advisory_xact_lock(<expr>) [AS x]`) is answered by the pool from an in-process lock table, with Postgres semantics: held by that client until its transaction ends; `try` returns false if another client holds it; the blocking form waits.

- The blocking form first takes the transaction's write mutex, then the key. Every blocking user of a key therefore already holds the mutex, so two of them never wait on each other.
- The `try` form does not take the mutex. That is what lets the cleanup job hold its lock while its work goes through the pool.
- The only possible cycle is a mutex holder waiting for a key held by a transaction that is itself waiting for the mutex. The pool detects it and fails one side with `40P01`, as Postgres's deadlock detector does.

## Schema and migrations

- `db/migrations/*.sql` (Postgres) are untouched.
- `db/sqlite/baseline.sql` is the schema the Postgres migrations listed in `db/sqlite/baseline.versions` produce, translated to SQLite: same tables, columns, defaults, `CHECK` constraints, foreign keys, unique and partial indexes. Defaults use only SQLite built-ins (`unixepoch()`, `strftime('%Y-%m-%dT%H:%M:%fZ')`).
- `db/sqlite/migrations/<same name as the Postgres migration>.sql` holds the SQLite version of each later Postgres migration.
- SQLite cannot change a table's `CHECK` constraints in place, so a migration that does (loosening `templates_roles_check`, say) makes the table again under the same name, as [SQLite's own procedure](https://www.sqlite.org/lang_altertable.html#otheralter) does: create the new table, copy the rows, drop the old one, rename the new one, make its indexes again. Such a file starts with the line `-- sqlite: rebuilds tables`, and the runner then applies it with foreign keys off (so dropping the old table neither cascades into the tables that point at it nor rewrites what they point at) and `legacy_alter_table` on, and runs `PRAGMA foreign_key_check` before it commits. Neither setting can change inside a transaction, which is why the file has to say so.
- `db/migrate.mjs` keeps its interface. With a `sqlite:` URL, `runMigrations` hands over to `db/sqlite/migrate.mjs`, which creates `signudoc_migrations`, applies the baseline to an empty database (recording every version in `baseline.versions`), then each file in `db/sqlite/migrations` not yet recorded, each in its own `BEGIN IMMEDIATE` transaction. Versions recorded are the Postgres migration names on both backends, which is what lets a backup taken on one backend be restored on the other.

CI checks (`db/sqlite/migrations.test.mjs`): every Postgres migration is either in `baseline.versions` or has a counterpart in `db/sqlite/migrations`, and nothing in either list is not a Postgres migration. `src/lib/db/sqlite/schema-parity.dbtest.ts` (run in the Postgres `test:db` job) migrates both and compares every table, column, column type class and nullability.

**Contributor rule:** every schema change needs a Postgres migration in `db/migrations` and a SQLite migration with the same file name in `db/sqlite/migrations`. CI fails without it.

## Better Auth

Better Auth supports SQLite through Kysely, including a `node:sqlite` dialect. Its own dialect cannot be used here: it would run statements on the shared connection without the pool's mutex, so a Better Auth write could land inside an app transaction (or start one inside it). Instead `src/lib/db/sqlite/kysely.ts` is a small Kysely dialect that uses Kysely's SQLite query compiler, adapter and introspector, and runs every statement through the SQLite pool's clients, so Better Auth shares the mutex, the reader connection and the type conversion. `createAppAuth` passes `{ dialect, type: "sqlite", transaction: true }` instead of the pool. With `type: "sqlite"` Better Auth writes dates as `toISOString()` and booleans as 0/1, the same representation as the rest of the app.

This adds `kysely` as a direct dependency. It is already installed (Better Auth depends on it, same version) and is pure JavaScript; the only change is that it is declared.

## Backups

SignuDoc's own backup (`src/lib/backup.ts`) works unchanged on SQLite and keeps its format: the table export (`database/*.ndjson.gz`, one JSON line per row) rather than a copy of the file. The export is read in one snapshot on a separate read-only connection, so it does not hold up writers, and every value is written in the same JSON form Postgres's `row_to_json` produces (booleans, timestamps, nested JSON). So the file is the same whichever backend wrote it, and `scripts/restore-backup.ts` restores a SQLite backup into Postgres and the other way round.

## Switching backends later

`scripts/transfer-database.ts` (`npm run transfer-database -- --from <URL> --to <URL>`) copies every row from one database into another, empty one, of either kind. It is the backup's export piped straight into the backup's restore, so it checks what a restore checks: the target is migrated first, must have no accounts, and gets everything in one transaction or nothing. Files are not copied; both installs point at the same file store. Stop the app first, so nothing changes during the copy.

Keep `BETTER_AUTH_SECRET` the same on the new backend: sessions are signed with it and two-step sign-in keys are encrypted with it. A Postgres install that never set one used a secret derived from its database password, which a `sqlite:` URL cannot supply, so moving it to SQLite needs a new `BETTER_AUTH_SECRET`; everyone is then signed out and anyone using two-step sign-in sets it up again, as after any change of the secret ([backup and restore](../backup-and-restore.md)).

## Tests and CI

- `npm test` (unit, no database) adds: the rewriter against every SQL string in the app (above), the rewriter's rules one by one, the functions, type round trips, the mutex under many concurrent async transactions (no interleaving, FIFO, timeout), advisory lock semantics and deadlock detection, and the migrations list check.
- `npm run test:db` runs on both backends. `openTestDatabase()` (`src/lib/db/test-database.ts`) returns a freshly migrated SQLite file per test file when `E2E_DATABASE_URL` is a `sqlite:` URL. The race tests ask Postgres who is waiting (`pg_locks`, `pg_stat_activity`); on SQLite those two names are views over the pool's own lock table (`pg_lock_waiters()`), so the same tests run unchanged.
- The end-to-end test (Playwright) runs on both: the server gets `DATABASE_URL=sqlite:…`, and the specs open the same file through `e2e/support/database.ts` (`openE2ePool`, `openE2eClient`) instead of `new pg.Pool`/`new pg.Client`. The test runner reads and writes the file beside the server there, which SQLite's own file locking handles; the app itself still runs as one process.
- `.github/workflows/ci.yml`: the `e2e` job is a matrix over `postgres` and `sqlite` (the Postgres service only matters to the first).

## Files outside the adapter

Application SQL: unchanged. Everything new is under `src/lib/db/sqlite/`, `db/sqlite/`, `e2e/support/database.ts`, `src/lib/db/disposable-database.ts` and `scripts/transfer-database.ts`. Existing files touched:

| File                                                                         | Change                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/db/connection.ts`                                                   | `getDb()` opens a `SqlitePool` for a `sqlite:` URL.                                                                                                                                                                                                                         |
| `db/migrate.mjs`                                                             | `runMigrations()` hands a `sqlite:` URL to `db/sqlite/migrate.mjs`.                                                                                                                                                                                                         |
| `src/lib/auth/server.ts`                                                     | `database` passed to Better Auth through `betterAuthDatabase(database)`.                                                                                                                                                                                                    |
| `src/lib/backup.ts`, `scripts/restore-backup.ts`                             | The export and the restore hand a SQLite pool to `src/lib/db/sqlite/backup.ts`; the restore script opens a `SqlitePool` for a `sqlite:` URL.                                                                                                                                |
| `src/lib/db/test-database.ts`                                                | `openTestDatabase()` returns a SQLite database for a `sqlite:` URL, and three helpers for tests that need a second writer (below).                                                                                                                                          |
| `e2e/global-setup.ts`                                                        | Empties a SQLite file instead of a Postgres schema when the URL is `sqlite:`.                                                                                                                                                                                               |
| `e2e/platform.spec.ts`, `e2e/signing-flow.spec.ts`                           | `new pg.Pool(…)` → `openE2ePool(…)`, `new pg.Client(…)` → `openE2eClient(…)`.                                                                                                                                                                                               |
| `src/lib/provider-signing.dbtest.ts`                                         | Its "pool of one connection" is opened with `openAnotherPool(database, …)`, which also opens SQLite. The second pool waits at most 3 s for the write lock there.                                                                                                            |
| `src/lib/signer-correction.dbtest.ts`, `src/lib/envelope-deletion.dbtest.ts` | Writes made from inside another transaction's work, as another session would, go through `besideOpenTransactions()`: awaited at once on Postgres, as before; on SQLite, which has one writer, awaited after the open transaction ends. The assertions are unchanged.        |
| `src/lib/account-purge.dbtest.ts`                                            | A write meant to land while the account row is locked goes through `afterStatementOrJustBefore`: on SQLite nothing is written while a transaction holds the database, so it lands just before that statement instead, the last moment it can. The assertions are unchanged. |
| `src/lib/envelope-deletion.dbtest.ts`, `src/lib/envelope-deadline.dbtest.ts` | Test setup only: a data-modifying `WITH … INSERT` is two statements, and a column alias `values` (a SQLite keyword) is renamed.                                                                                                                                             |
| `src/lib/envelope-deletion.dbtest.ts`                                        | One test on Postgres only: a cancelled request scheduled again while the daily run clears cancelled ones is kept, because that `DELETE … USING` checks again the row it waited for.                                                                                         |
| `package.json`, `package-lock.json`                                          | `kysely` declared; `transfer-database` script.                                                                                                                                                                                                                              |

When a query is added, nothing needs doing unless CI's corpus test fails, in which case the fix goes in the rewriter or the functions, not at the call site. When a migration is added, its SQLite counterpart is the only new file.
