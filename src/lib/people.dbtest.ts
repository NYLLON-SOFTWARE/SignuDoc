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
    setPersonRole(first, "user", database),
    refusedWith(409, /at least one administrator/),
  );
  assert.equal(await roleOf(first), "admin");

  assert.equal((await setPersonRole(second, "admin", database)).role, "admin");
  assert.equal((await setPersonRole(first, "user", database)).role, "user");
  assert.equal(await roleOf(first), "user");
  assert.equal(await roleOf(second), "admin");

  // Asking for the role an account already has changes nothing.
  assert.equal((await setPersonRole(second, "admin", database)).role, "admin");

  const listed = await listPeople(database);
  const mine = listed.filter((person) => createdUsers.includes(person.id));

  // Administrators come first.
  assert.equal(mine[0]?.id, second);
  assert.equal(mine[0]?.role, "admin");
});

test("two administrators removing each other at once leaves one", async () => {
  await resetRoles();

  const left = await createUser({ role: "admin" });
  const right = await createUser({ role: "admin" });
  const results = await Promise.allSettled([
    setPersonRole(left, "user", database),
    setPersonRole(right, "user", database),
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
    setPersonRole(staying, "user", database),
    refusedWith(409, /at least one administrator/),
  );

  const person = (await listPeople(database)).find(
    (entry) => entry.id === leaving,
  );

  assert.equal(person?.closing, true);
});

test("only a confirmed account that is staying can become an administrator", async () => {
  await resetRoles();
  await createUser({ role: "admin" });

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
    setPersonRole(unverified, "admin", database),
    refusedWith(409, /not confirmed their email/),
  );
  await assert.rejects(
    setPersonRole(closing, "admin", database),
    refusedWith(409, /being closed/),
  );
  await assert.rejects(
    setPersonRole(randomUUID(), "admin", database),
    refusedWith(404, /no longer exists/),
  );
});
