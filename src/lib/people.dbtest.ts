import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { listPeople, PeopleError, setPersonRole } from "./people.ts";

// Administrator roles against a real Postgres: there is always at least
// one, even when two removals arrive at once. Run with `npm run test:db`.

let database: pg.Pool;
const createdUsers: string[] = [];
let administratorsBefore: string[] = [];

before(async () => {
  database = await openTestDatabase();

  // The rule under test is about every administrator in the database, so
  // the ones other tests left behind step aside while this file runs.
  const existing = await database.query<{ id: string }>(
    `update public."user" set role = 'user' where role = 'admin' returning id`,
  );

  administratorsBefore = existing.rows.map((row) => row.id);
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.query(
    `update public."user" set role = 'admin' where id = any($1)`,
    [administratorsBefore],
  );
  await database.end();
});

async function createUser({
  role = "user",
  verified = true,
}: { role?: "admin" | "user"; verified?: boolean } = {}) {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, $4, $5)
    `,
    [id, `Person ${id.slice(0, 4)}`, `${id}@example.test`, role, verified],
  );

  return id;
}

async function roleOf(userId: string) {
  const result = await database.query<{ role: string }>(
    `select role from public."user" where id = $1`,
    [userId],
  );

  return result.rows[0]?.role ?? null;
}

async function resetRoles() {
  await database.query(
    `update public."user" set role = 'user' where id = any($1)`,
    [createdUsers],
  );
}

/** Waits until this many sessions are held up behind a lock. */
async function waitForLockWaiters(count: number) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await database.query<{ waiting: number }>(
      `
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `,
    );

    if ((result.rows[0]?.waiting ?? 0) >= count) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Expected ${count} sessions to be waiting behind a lock.`);
}

function refusedWith(statusCode: number, pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof PeopleError);
    assert.equal(error.statusCode, statusCode);
    assert.match(error.message, pattern);
    return true;
  };
}

test("an administrator can be added and removed, but never the last one", async () => {
  await resetRoles();

  const first = await createUser({ role: "admin" });
  const second = await createUser();

  await assert.rejects(
    setPersonRole(first, first, "user", database),
    refusedWith(409, /at least one administrator/),
  );
  assert.equal(await roleOf(first), "admin");

  assert.equal(
    (await setPersonRole(first, second, "admin", database)).role,
    "admin",
  );
  assert.equal(
    (await setPersonRole(first, first, "user", database)).role,
    "user",
  );
  assert.equal(await roleOf(first), "user");
  assert.equal(await roleOf(second), "admin");

  // Asking for the role an account already has changes nothing.
  assert.equal(
    (await setPersonRole(second, second, "admin", database)).role,
    "admin",
  );

  // Having given the role up, the first account can no longer hand it out.
  await assert.rejects(
    setPersonRole(first, first, "admin", database),
    refusedWith(403, /Only an administrator/),
  );
  assert.equal(await roleOf(first), "user");

  const listed = await listPeople({}, database);
  const mine = listed.people.filter((person) =>
    createdUsers.includes(person.id),
  );

  // Administrators come first.
  assert.equal(mine[0]?.id, second);
  assert.equal(mine[0]?.role, "admin");
});

test("two administrators removing each other at once leaves one", async () => {
  await resetRoles();

  const left = await createUser({ role: "admin" });
  const right = await createUser({ role: "admin" });
  const results = await Promise.allSettled([
    setPersonRole(right, left, "user", database),
    setPersonRole(left, right, "user", database),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  assert.deepEqual([await roleOf(left), await roleOf(right)].sort(), [
    "admin",
    "user",
  ]);
});

test("a request already under way does not outlive its administrator's role", async () => {
  await resetRoles();

  const staying = await createUser({ role: "admin" });
  const removed = await createUser({ role: "admin" });
  const holder = await database.connect();

  try {
    // Holds the removal up at the account it is about to change, which is
    // after it has taken its turn among role changes.
    await holder.query("begin");
    await holder.query(`select 1 from public."user" where id = $1 for update`, [
      removed,
    ]);

    const removal = setPersonRole(staying, removed, "user", database);

    removal.catch(() => undefined);
    await waitForLockWaiters(1);

    // Sent while still an administrator, as the route had checked. It now
    // waits its turn behind the removal.
    const late = setPersonRole(removed, removed, "admin", database);

    late.catch(() => undefined);
    await waitForLockWaiters(2);
    await holder.query("commit");

    assert.equal((await removal).role, "user");
    await assert.rejects(late, refusedWith(403, /Only an administrator/));
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
  }

  assert.equal(await roleOf(removed), "user");
  assert.equal(await roleOf(staying), "admin");
});

test("an administrator whose account is closing does not count as the one that stays", async () => {
  await resetRoles();

  const staying = await createUser({ role: "admin" });
  const leaving = await createUser({ role: "admin" });

  await database.query(
    `
      insert into account_closure_requests
        (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
      values ($1, 1, 2, 3, 1)
    `,
    [leaving],
  );

  await assert.rejects(
    setPersonRole(staying, staying, "user", database),
    refusedWith(409, /at least one administrator/),
  );

  const person = (await listPeople({}, database)).people.find(
    (entry) => entry.id === leaving,
  );

  assert.equal(person?.closing, true);
});

test("only a confirmed account that is staying can become an administrator", async () => {
  await resetRoles();

  const administrator = await createUser({ role: "admin" });

  const unverified = await createUser({ verified: false });
  const closing = await createUser();

  await database.query(
    `
      insert into account_closure_requests
        (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
      values ($1, 1, 2, 3, 1)
    `,
    [closing],
  );

  await assert.rejects(
    setPersonRole(administrator, unverified, "admin", database),
    refusedWith(409, /not confirmed their email/),
  );
  await assert.rejects(
    setPersonRole(administrator, closing, "admin", database),
    refusedWith(409, /being closed/),
  );
  await assert.rejects(
    setPersonRole(administrator, randomUUID(), "admin", database),
    refusedWith(404, /no longer exists/),
  );
});

test("an account past the end of the list can still be found and made an administrator", async () => {
  await resetRoles();

  const administrator = await createUser({ role: "admin" });
  // More accounts than the list holds, all of them sorting ahead of the one
  // looked for below.
  const crowd = await database.query<{ id: string }>(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      select
        gen_random_uuid()::text,
        'Crowd ' || n,
        'crowd-' || n || '-' || $1 || '@example.test',
        'user',
        true
      from generate_series(1, 510) as n
      returning id
    `,
    [randomUUID()],
  );

  createdUsers.push(...crowd.rows.map((row) => row.id));

  const last = randomUUID();

  createdUsers.push(last);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, 'Zofia Zzzlast', $2, 'user', true)
    `,
    [last, `Zofia.${last}@Example.test`],
  );

  const everyone = await listPeople({}, database);

  assert.equal(everyone.people.length, 500);
  assert.ok(everyone.total > 500);
  assert.equal(everyone.people[0]?.id, administrator);
  assert.equal(
    everyone.people.some((person) => person.id === last),
    false,
  );

  // By part of the name, whatever its case and the spaces around it.
  const byName = await listPeople({ search: "  zofia ZZZ " }, database);

  assert.deepEqual(
    byName.people.map((person) => person.id),
    [last],
  );
  assert.equal(byName.total, 1);
  // Counted among every account, not only the ones found.
  assert.equal(byName.administratorCount, 1);

  // By part of the email address.
  const byEmail = await listPeople({ search: `zofia.${last}@` }, database);

  assert.deepEqual(
    byEmail.people.map((person) => person.id),
    [last],
  );

  assert.equal(
    (await listPeople({ search: "nobody at all" }, database)).total,
    0,
  );
  assert.equal(
    (await setPersonRole(administrator, last, "admin", database)).role,
    "admin",
  );
});
