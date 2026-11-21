import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { Kysely } from "kysely";

import { runMigrations } from "../../../../db/migrate.mjs";
import { createSqliteDialect } from "./kysely.ts";
import { SqliteDatabaseError, SqlitePool } from "./pool.ts";

// The SQLite pool on a real file with the app's schema: types, the write
// lock, advisory locks, errors. No Postgres needed.

const directory = mkdtempSync(path.join(tmpdir(), "signudoc-sqlite-pool-"));
const url = `sqlite:${path.join(directory, "pool.db")}`;
let pool: SqlitePool;

before(async () => {
  await runMigrations({ connectionString: url, log: () => undefined });
  pool = new SqlitePool(url, { lockTimeoutMs: 2000 });
});

after(async () => {
  await pool.end();
  rmSync(directory, { force: true, recursive: true });
});

let counter = 0;

async function addUser(overrides: Record<string, unknown> = {}) {
  counter += 1;

  const id = `user-${String(counter)}`;

  await pool.query(
    `insert into public."user" (id, name, email, "emailVerified", role) values ($1, $2, $3, $4, $5)`,
    [
      id,
      overrides.name ?? "Pat",
      `${id}@example.test`,
      overrides.emailVerified ?? false,
      "user",
    ],
  );

  return id;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("values come back as pg returns them", async () => {
  const id = await addUser({ emailVerified: true });
  const created = new Date("2026-03-04T05:06:07.089Z");

  await pool.query(`update "user" set "createdAt" = $1 where id = $2`, [
    created,
    id,
  ]);
  await pool.query(
    `insert into app_settings (id, allowed_email_domains, created_at, updated_at) values (true, $1, 1, 2)
     on conflict (id) do update set allowed_email_domains = excluded.allowed_email_domains`,
    [["acme.com", "acme.org"]],
  );

  const user = await pool.query<Record<string, unknown>>(
    `select "emailVerified", "createdAt", signing_failed_attempts from "user" where id = $1`,
    [id],
  );
  const settings = await pool.query<Record<string, unknown>>(
    "select id, allowed_email_domains, part11_mode from app_settings",
  );

  assert.deepEqual(user.rows, [
    { createdAt: created, emailVerified: true, signing_failed_attempts: 0 },
  ]);
  assert.deepEqual(settings.rows, [
    {
      allowed_email_domains: ["acme.com", "acme.org"],
      id: true,
      part11_mode: false,
    },
  ]);
  assert.equal(Object.getPrototypeOf(user.rows[0]), Object.prototype);
});

test("computed columns are converted by what they compute", async () => {
  const id = await addUser();
  const result = await pool.query<Record<string, unknown>>(
    `select exists (select 1 from "user" where id = $1) as found,
            count(*)::int as total,
            max("createdAt") as latest,
            jsonb_build_object('id', $1::text) as object,
            array(select id from "user" where id = $1) as ids
     from "user"`,
    [id],
  );
  const row = result.rows[0]!;

  assert.equal(row.found, true);
  assert.equal(typeof row.total, "number");
  assert.ok(row.latest instanceof Date);
  assert.deepEqual(row.object, { id });
  assert.deepEqual(row.ids, [id]);
});

test("timestamps are stored in one format, so text order is time order", async () => {
  const times = [
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.5Z",
    "2025-12-31T23:59:59.999Z",
    "2026-01-01T00:00:09Z",
  ].map((time) => new Date(time));

  for (const [index, time] of times.entries()) {
    await pool.query(
      `insert into verification (id, identifier, value, "expiresAt") values ($1, 'order', 'v', $2)`,
      [`order-${String(index)}`, time],
    );
  }

  const stored = await pool.query<{ expiresAt: Date }>(
    `select "expiresAt" from verification where identifier = 'order' order by "expiresAt"`,
  );
  const raw = await pool.query<{ text: string }>(
    `select "expiresAt"::text as text from verification where identifier = 'order' order by 1`,
  );

  assert.deepEqual(
    stored.rows.map((row) => row.expiresAt.getTime()),
    times.map((time) => time.getTime()).sort((a, b) => a - b),
  );
  for (const { text } of raw.rows) {
    assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }

  const later = await pool.query<{ n: number }>(
    `select count(*)::int as n from verification where identifier = 'order' and "expiresAt" > $1`,
    [new Date("2026-01-01T00:00:00.000Z")],
  );

  assert.equal(later.rows[0]!.n, 2);
});

test("now() is one time for a whole transaction", async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const first = await client.query<{ now: Date }>("select now() as now");

    await sleep(20);

    const second = await client.query<{ now: Date }>(
      "select now() as now from generate_series(1, 3) as n",
    );

    assert.ok(
      second.rows.every(
        (row) => row.now.getTime() === first.rows[0]!.now.getTime(),
      ),
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
});

test("functions with Postgres names behave as in Postgres", async () => {
  const result = await pool.query<Record<string, unknown>>(
    `select greatest(1, null, 3) as g, least(null, 2) as l, left('abcdef', -2) as lt, right('abcdef', 2) as rt,
            (1.5)::int as up, (-1.5)::int as down, (7 / 2)::int as division,
            extract(epoch from '2026-01-01T00:00:01Z'::timestamptz) as epoch,
            encode(sha256('abc'::bytea), 'hex') as digest,
            gen_random_uuid() as uuid,
            substring('pat@acme.com' from '@([^@]+)$') as domain,
            position('b' in 'abc') as at`,
  );
  const row = result.rows[0]!;

  assert.equal(row.g, 3);
  assert.equal(row.l, 2);
  assert.equal(row.lt, "abcd");
  assert.equal(row.rt, "ef");
  assert.equal(row.up, 2);
  assert.equal(row.down, -2);
  assert.equal(row.division, 3);
  assert.equal(row.epoch, 1767225601);
  assert.equal(
    row.digest,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.match(String(row.uuid), /^[0-9a-f-]{36}$/);
  assert.equal(row.domain, "acme.com");
  assert.equal(row.at, 2);
});

test("errors carry the Postgres codes the app checks", async () => {
  const id = await addUser();

  await assert.rejects(
    pool.query(`insert into "user" (id, name, email) values ($1, 'x', 'y')`, [
      id,
    ]),
    (error: unknown) =>
      error instanceof SqliteDatabaseError && error.code === "23505",
  );
  await assert.rejects(pool.query("select * from no_such_table"), {
    code: "42P01",
  });
  await assert.rejects(pool.query(`select no_such_column from "user"`), {
    code: "42703",
  });
  await assert.rejects(
    pool.query(
      `insert into session (id, "expiresAt", token, "userId") values ('s', now(), 't', 'nobody')`,
    ),
    {
      code: "23503",
    },
  );
  await assert.rejects(
    pool.query(`update "user" set role = 'owner' where id = $1`, [id]),
    { code: "23514" },
  );
});

test("an error inside a transaction aborts it, as on Postgres", async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await assert.rejects(client.query("select * from no_such_table"));
    await assert.rejects(client.query("select 1"), { code: "25P02" });
    await client.query("ROLLBACK");
    assert.deepEqual((await client.query("select 1 as one")).rows, [
      { one: 1 },
    ]);
  } finally {
    client.release();
  }
});

test("a transaction holds the write lock from its first write to its end", async () => {
  const events: string[] = [];
  const holder = await pool.connect();

  await holder.query("BEGIN");
  await holder.query(`update "user" set name = name where id = 'none'`);

  const rival = pool
    .query(
      `insert into rate_limits (key, count, expires_at) values ('lock-order', 1, 1)`,
    )
    .then(() => {
      events.push("rival wrote");
    });

  await sleep(30);
  events.push("holder commits");
  await holder.query("COMMIT");
  holder.release();
  await rival;

  assert.deepEqual(events, ["holder commits", "rival wrote"]);
});

test("reads outside a transaction see what is committed, without waiting", async () => {
  const id = await addUser({ name: "Before" });
  const holder = await pool.connect();

  try {
    await holder.query("BEGIN");
    await holder.query(`update "user" set name = 'After' where id = $1`, [id]);

    const outside = await pool.query<{ name: string }>(
      `select name from "user" where id = $1`,
      [id],
    );
    const inside = await holder.query<{ name: string }>(
      `select name from "user" where id = $1`,
      [id],
    );

    assert.equal(outside.rows[0]!.name, "Before");
    assert.equal(inside.rows[0]!.name, "After");
    await holder.query("COMMIT");
  } finally {
    holder.release();
  }

  assert.equal(
    (
      await pool.query<{ name: string }>(
        `select name from "user" where id = $1`,
        [id],
      )
    ).rows[0]!.name,
    "After",
  );
});

test("a transaction that has only read holds nothing; a locking read takes the lock", async () => {
  const holder = await pool.connect();
  const order: string[] = [];

  try {
    await holder.query("BEGIN");
    await holder.query(`select count(*) from "user"`);
    // As in a Postgres READ COMMITTED transaction: a plain read locks nothing.
    await pool.query(
      `insert into rate_limits (key, count, expires_at) values ('read-only', 1, 1)`,
    );
    await holder.query(
      `select * from rate_limits where key = 'read-only' for update`,
    );

    const rival = pool
      .query(`update rate_limits set count = 2 where key = 'read-only'`)
      .then(() => order.push("rival wrote"));

    await sleep(30);
    order.push("holder commits");
    await holder.query("COMMIT");
    await rival;
  } finally {
    holder.release();
  }

  assert.deepEqual(order, ["holder commits", "rival wrote"]);
});

test("a division by zero is an error, as on Postgres", async () => {
  await assert.rejects(pool.query("select 1 / 0"), { code: "22012" });
  assert.deepEqual((await pool.query("select 7 / 2 as i, 7.0 / 2 as r")).rows, [
    { i: 3, r: 3.5 },
  ]);
});

test("a pool looks like a pg pool to the code that asks", () => {
  assert.ok("connect" in pool && "totalCount" in pool);
});

test("concurrent async transactions never interleave", async () => {
  await pool.query(
    `insert into rate_limits (key, count, expires_at) values ('counter', 0, 1)`,
  );

  const increment = async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{ count: number }>(
        `select count from rate_limits where key = 'counter' for update`,
      );

      await sleep(Math.random() * 3);
      await client.query(
        `update rate_limits set count = $1 where key = 'counter'`,
        [rows[0]!.count + 1],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  };

  await Promise.all(Array.from({ length: 40 }, increment));

  const { rows } = await pool.query<{ count: number }>(
    `select count from rate_limits where key = 'counter'`,
  );

  assert.equal(rows[0]!.count, 40);
});

test("a write that waits too long for the lock fails instead of hanging", async () => {
  const short = new SqlitePool(url, { lockTimeoutMs: 50 });
  const holder = await pool.connect();

  try {
    await holder.query("BEGIN");
    await holder.query(`update "user" set name = name where id = 'none'`);
    await assert.rejects(
      short.query(`delete from rate_limits where key = 'nothing'`),
      { code: "55P03" },
    );
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await short.end();
  }
});

test("try-lock: another transaction is told no until the holder ends", async () => {
  const first = await pool.connect();
  const second = await pool.connect();

  try {
    await first.query("begin");
    await second.query("begin");

    const mine = await first.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock($1) as locked",
      [42],
    );
    const theirs = await second.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock($1) as locked",
      [42],
    );

    assert.equal(mine.rows[0]!.locked, true);
    assert.equal(theirs.rows[0]!.locked, false);

    // Holding only a lock does not stop anyone writing.
    await pool.query(`delete from rate_limits where key = 'nothing'`);

    await first.query("rollback");

    const again = await second.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock($1) as locked",
      [42],
    );

    assert.equal(again.rows[0]!.locked, true);
  } finally {
    await first.query("rollback");
    await second.query("rollback");
    first.release();
    second.release();
  }
});

test("a blocking advisory lock waits, and pg_locks shows the waiter", async () => {
  const holder = await pool.connect();
  const order: string[] = [];

  await holder.query("begin");
  await holder.query(
    "select pg_try_advisory_xact_lock(hashtextextended($1, 7))",
    ["envelope-1"],
  );

  const waiter = (async () => {
    const client = await pool.connect();

    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 7))",
        ["envelope-1"],
      );
      order.push("waiter has it");
      await client.query("commit");
    } finally {
      client.release();
    }
  })();

  let waiting = 0;

  for (let attempt = 0; attempt < 100 && waiting === 0; attempt += 1) {
    await sleep(5);
    waiting = (
      await pool.query(
        `select 1 from pg_locks where locktype = 'advisory' and not granted limit 1`,
      )
    ).rowCount;
  }

  assert.equal(waiting, 1);

  const activity = await pool.query<{ waiting: number }>(
    `select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );

  assert.equal(activity.rows[0]!.waiting, 1);
  order.push("holder ends");
  await holder.query("commit");
  holder.release();
  await waiter;
  assert.deepEqual(order, ["holder ends", "waiter has it"]);
});

test("waiting on each other's lock and write lock is a deadlock, reported as one", async () => {
  const keyHolder = await pool.connect();
  const lockHolder = await pool.connect();

  try {
    await keyHolder.query("begin");
    await keyHolder.query("select pg_try_advisory_xact_lock(99)");
    await lockHolder.query("begin");
    await lockHolder.query(`update "user" set name = name where id = 'none'`);

    const keyHolderWrites = keyHolder.query(
      `update "user" set name = name where id = 'none'`,
    );

    keyHolderWrites.catch(() => undefined);
    await sleep(5);
    await assert.rejects(lockHolder.query("select pg_advisory_xact_lock(99)"), {
      code: "40P01",
    });
    await lockHolder.query("rollback");
    await keyHolderWrites;
  } finally {
    await keyHolder.query("rollback");
    await lockHolder.query("rollback").catch(() => undefined);
    keyHolder.release();
    lockHolder.release();
  }
});

test("a data-modifying WITH runs, and hands its rows on", async () => {
  const id = await addUser({ name: "Member" });

  await pool.query(
    `insert into rate_limits (key, count, expires_at) values ($1, 1, 1)`,
    [id],
  );

  const removed = await pool.query<{ name: string }>(
    `WITH removed AS (DELETE FROM rate_limits WHERE key = $1 RETURNING key)
     SELECT u.name FROM removed JOIN public."user" u ON u.id = removed.key`,
    [id],
  );

  assert.deepEqual(removed.rows, [{ name: "Member" }]);
  assert.equal(
    (await pool.query("select 1 from rate_limits where key = $1", [id]))
      .rowCount,
    0,
  );
});

test("a REPEATABLE READ transaction reads on one snapshot while writes go on", async () => {
  const id = await addUser({ name: "Before" });
  const client = await pool.connect();
  const nameNow = async () =>
    (
      await client.query<{ name: string }>(
        `select name from public."user" where id = $1`,
        [id],
      )
    ).rows[0]?.name;

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal(await nameNow(), "Before");

    // Not held up by the open transaction, and not seen by it.
    await pool.query(`update public."user" set name = 'After' where id = $1`, [
      id,
    ]);
    assert.equal(await nameNow(), "Before");

    await client.query("COMMIT");
    assert.equal(await nameNow(), "After");
  } finally {
    client.release();
  }
});

test("a WITH that modifies data in several parts runs each, in order", async () => {
  const key = `chain-${String(Date.now())}`;
  const chain = `
    WITH bumped AS (
      UPDATE rate_limits SET count = count + 1 WHERE key = $1
      RETURNING key, count
    ),
    noted AS (
      INSERT INTO rate_limits (key, count, expires_at)
      SELECT bumped.key || ':' || n.v, bumped.count, $2
      FROM bumped
      CROSS JOIN unnest($3::int[]) AS n(v)
      ON CONFLICT (key) DO NOTHING
    )
    SELECT key, count FROM bumped
  `;

  await pool.query(
    `insert into rate_limits (key, count, expires_at) values ($1, 1, 1)`,
    [key],
  );

  const result = await pool.query<{ count: number; key: string }>(chain, [
    key,
    7,
    [1, 2],
  ]);

  assert.deepEqual(result.rows, [{ count: 2, key }]);
  assert.deepEqual(
    (
      await pool.query(
        "select key, count, expires_at from rate_limits where key like $1 order by key",
        [`${key}:%`],
      )
    ).rows,
    [
      { count: 2, expires_at: 7, key: `${key}:1` },
      { count: 2, expires_at: 7, key: `${key}:2` },
    ],
  );

  // Nothing to update: nothing inserted, and no rows.
  const missing = await pool.query(chain, [`${key}-none`, 7, [1]]);

  assert.equal(missing.rowCount, 0);
  assert.equal(
    (
      await pool.query("select 1 from rate_limits where key = $1", [
        `${key}-none:1`,
      ])
    ).rowCount,
    0,
  );
});

test("Better Auth's queries run through the same pool", async () => {
  const db = new Kysely<Record<string, Record<string, unknown>>>({
    dialect: createSqliteDialect(pool),
  });
  const id = await addUser({ name: "Kysely" });

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("user")
      .set({ name: "Renamed" })
      .where("id", "=", id)
      .execute();
  });

  const row = await db
    .selectFrom("user")
    .select(["name", "emailVerified"])
    .where("id", "=", id)
    .executeTakeFirst();

  assert.deepEqual(row, { emailVerified: false, name: "Renamed" });
});

test("statements issued on one client without awaiting run in order", async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await Promise.all([
      client.query(
        `insert into rate_limits (key, count, expires_at) values ('serial-a', 1, 1)`,
      ),
      client.query(
        `insert into rate_limits (key, count, expires_at) values ('serial-b', 1, 1)`,
      ),
    ]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  const rows = await pool.query<{ key: string }>(
    `select key from rate_limits where key in ('serial-a', 'serial-b') order by key`,
  );

  assert.deepEqual(
    rows.rows.map((row) => row.key),
    ["serial-a", "serial-b"],
  );
});

test("lower() folds every letter, as Postgres does", async () => {
  const folded = await pool.query<{ l: string; n: null }>(
    `select lower('Émile Zola') as l, lower(null) as n`,
  );

  assert.equal(folded.rows[0]!.l, "émile zola");
  assert.equal(folded.rows[0]!.n, null);
});

test("generate_series(a, b) is empty when a is past b", async () => {
  const empty = await pool.query<{ n: number }>(
    `select count(*) as n from generate_series(1, 0) as n`,
  );
  const three = await pool.query<{ n: number }>(
    `select count(*) as n from generate_series(1, 3) as n`,
  );

  assert.equal(Number(empty.rows[0]!.n), 0);
  assert.equal(Number(three.rows[0]!.n), 3);
});

test("jsonb_typeof names types as Postgres does", async () => {
  const result = await pool.query<Record<string, unknown>>(
    `select jsonb_typeof('"x"'::jsonb) as s, jsonb_typeof('1'::jsonb) as n, jsonb_typeof('1.5'::jsonb) as f,
            jsonb_typeof('true'::jsonb) as b, jsonb_typeof('null'::jsonb) as z,
            jsonb_typeof('[1]'::jsonb) as a, jsonb_typeof('{"k": 1}'::jsonb) as o`,
  );

  assert.deepEqual(result.rows[0], {
    a: "array",
    b: "boolean",
    f: "number",
    n: "number",
    o: "object",
    s: "string",
    z: "null",
  });
});

test("row_to_json gives boolean columns as JSON booleans", async () => {
  const owner = await addUser();

  await pool.query(
    `insert into envelopes (id, user_id, title, source_pdf_key, source_pdf_filename, source_pdf_size_bytes, page_count, source_pdf_hash)
     values ('env-rtj', $1, 'T', 'k', 'f.pdf', 1, 1, $2)`,
    [owner, "b".repeat(64)],
  );
  await pool.query(
    `insert into signers (id, envelope_id, name, email, sign_order, require_email_code) values ('rtj-signer', 'env-rtj', 'A', 'a@x.test', 1, true)`,
  );

  const result = await pool.query<{ j: unknown }>(
    `select row_to_json(s)::text as j from signers s where s.id = 'rtj-signer'`,
  );
  const row = (
    typeof result.rows[0]!.j === "string"
      ? JSON.parse(result.rows[0]!.j)
      : result.rows[0]!.j
  ) as Record<string, unknown>;

  assert.equal(row.require_email_code, true);
  assert.equal(typeof row.require_email_code, "boolean");
});

test("a table changed after a row_to_json query is seen by the next one", async () => {
  await pool.query("create table rtj_probe (a integer)");
  await pool.query("insert into rtj_probe (a) values (1)");

  const query = `select row_to_json(t)::text as j from rtj_probe t`;
  const parse = (value: unknown) =>
    (typeof value === "string" ? JSON.parse(value) : value) as Record<
      string,
      unknown
    >;
  const before = await pool.query<{ j: unknown }>(query);

  assert.deepEqual(Object.keys(parse(before.rows[0]!.j)), ["a"]);
  await pool.query("alter table rtj_probe add column c integer default 5");

  const after = await pool.query<{ j: unknown }>(query);

  assert.deepEqual(Object.keys(parse(after.rows[0]!.j)).sort(), ["a", "c"]);
  await pool.query("drop table rtj_probe");
});
