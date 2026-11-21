import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import {
  ApiKeyError,
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  LISTED_REVOKED_API_KEYS,
  MAX_API_KEYS_PER_USER,
  revokeApiKey,
} from "./api-keys.ts";
import {
  needsPostgresLocks,
  openTestDatabase,
  waitUntilBlockedBy,
} from "./db/test-database.ts";
import { setPersonRole } from "./people.ts";
import { SYSTEM_AUDIT_LOCK_ID } from "./services/system-audit.ts";

// API keys against a real Postgres. Run with `npm run test:db`.

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

async function createUser(role: "admin" | "user" = "admin") {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, $4, true)
    `,
    [id, `Person ${id.slice(0, 4)}`, `${id}@example.test`, role],
  );

  return { email: `${id}@example.test`, userId: id };
}

async function systemEventsFor(apiKeyId: string) {
  const result = await database.query<{ event: string; reason: string | null }>(
    `
      select event, metadata->>'reason' as reason
      from system_audit_events
      where metadata->>'apiKeyId' = $1
      order by sequence
    `,
    [apiKeyId],
  );

  return result.rows;
}

test("a new key works, acts as its creator, and only its hash is kept", async () => {
  const admin = await createUser();
  const { key, summary } = await createApiKey(
    admin,
    { expiresInDays: null, name: "Billing app", scope: "write" },
    database,
  );

  const principal = await authenticateApiKey(key, database);

  assert.equal(principal?.user.id, admin.userId);
  assert.equal(principal?.apiKey.scope, "write");
  assert.equal(summary.prefix, key.slice(0, 12));

  const stored = await database.query(`select * from api_keys where id = $1`, [
    summary.id,
  ]);

  assert.ok(!JSON.stringify(stored.rows[0]).includes(key));
  assert.deepEqual(
    (await systemEventsFor(summary.id)).map((row) => row.event),
    ["api_key_created"],
  );
  assert.ok((await listApiKeys(database)).some((row) => row.id === summary.id));
});

test("an unknown key and a key of the wrong shape are both refused", async () => {
  assert.equal(
    await authenticateApiKey(`sdk_${"A".repeat(43)}`, database),
    null,
  );
  assert.equal(await authenticateApiKey("not-a-key", database), null);
});

test("a revoked key stops working at once and stays revoked", async () => {
  const admin = await createUser();
  const { key, summary } = await createApiKey(
    admin,
    { expiresInDays: 30, name: "Old app", scope: "read" },
    database,
  );

  await revokeApiKey(admin, summary.id, database);
  // A second revoke changes nothing and records nothing.
  await revokeApiKey(admin, summary.id, database);

  assert.equal(await authenticateApiKey(key, database), null);
  assert.deepEqual(
    (await systemEventsFor(summary.id)).map((row) => row.event),
    ["api_key_created", "api_key_revoked"],
  );
});

test("an expired key is refused", async () => {
  const admin = await createUser();
  const { key } = await createApiKey(
    admin,
    { expiresInDays: 30, name: "Short-lived", scope: "write" },
    database,
  );
  const later = Math.floor(Date.now() / 1000) + 31 * 24 * 60 * 60;

  assert.ok(await authenticateApiKey(key, database));
  assert.equal(await authenticateApiKey(key, database, later), null);
});

test("using a key records when, at most once a minute, and never moves the time back", async () => {
  const admin = await createUser();
  const { key, summary } = await createApiKey(
    admin,
    { expiresInDays: null, name: "Busy app", scope: "read" },
    database,
  );
  const lastUsedAt = async () => {
    const result = await database.query<{ last_used_at: string | null }>(
      `select last_used_at::text from api_keys where id = $1`,
      [summary.id],
    );
    const value = result.rows[0]?.last_used_at ?? null;

    return value === null ? null : Number(value);
  };
  const start = Math.floor(Date.now() / 1000);

  assert.equal(await lastUsedAt(), null);
  assert.ok(await authenticateApiKey(key, database, start));
  assert.equal(await lastUsedAt(), start);

  // Within the minute the time is not written again.
  assert.ok(await authenticateApiKey(key, database, start + 30));
  assert.equal(await lastUsedAt(), start);

  // Once it is over, it is.
  assert.ok(await authenticateApiKey(key, database, start + 61));
  assert.equal(await lastUsedAt(), start + 61);

  // A request that read the key before a newer time was written cannot
  // put an older one back: here another request writes a later time just
  // before this one's write, and the write checks the row as it is then.
  const racing: Pick<pg.Pool, "query"> = {
    query: (async (text: string, values?: unknown[]) => {
      if (text.includes("UPDATE api_keys SET last_used_at")) {
        await database.query(
          `update api_keys set last_used_at = $2 where id = $1`,
          [summary.id, start + 500],
        );
      }

      return database.query(text, values);
    }) as pg.Pool["query"],
  };

  assert.ok(await authenticateApiKey(key, racing, start + 200));
  assert.equal(await lastUsedAt(), start + 500);
});

test("an administrator who loses the role loses their keys for good", async () => {
  const stays = await createUser();
  const leaves = await createUser();
  const { key, summary } = await createApiKey(
    leaves,
    { expiresInDays: null, name: "Leaver's app", scope: "write" },
    database,
  );

  await setPersonRole(stays.userId, leaves.userId, "user", database);

  assert.equal(await authenticateApiKey(key, database), null);

  await setPersonRole(stays.userId, leaves.userId, "admin", database);

  assert.equal(await authenticateApiKey(key, database), null);
  assert.deepEqual(await systemEventsFor(summary.id), [
    { event: "api_key_created", reason: null },
    { event: "api_key_revoked", reason: "role_removed" },
  ]);
});

test("a key stops working while its owner's account is being closed", async () => {
  const admin = await createUser();
  const { key, summary } = await createApiKey(
    admin,
    { expiresInDays: null, name: "Closing", scope: "write" },
    database,
  );
  const now = Math.floor(Date.now() / 1000);

  assert.equal(summary.ownerClosing, false);

  await database.query(
    `
      insert into account_closure_requests (
        user_id, requested_at, export_expires_at, purge_after_at, updated_at
      ) values ($1, $2, $2, $2, $2)
    `,
    [admin.userId, now],
  );

  assert.equal(await authenticateApiKey(key, database), null);
  // Settings shows the key as stopped rather than active, so nobody is
  // told a key works while every request with it is turned away.
  const listed = (await listApiKeys(database)).find(
    (row) => row.id === summary.id,
  );
  assert.equal(listed?.ownerClosing, true);
  assert.equal(listed?.revokedAt, null);
});

test("only an administrator can create or revoke keys", async () => {
  const member = await createUser("user");
  const admin = await createUser();
  const { summary } = await createApiKey(
    admin,
    { expiresInDays: null, name: "Theirs", scope: "write" },
    database,
  );

  await assert.rejects(
    createApiKey(
      member,
      { expiresInDays: null, name: "Mine", scope: "write" },
      database,
    ),
    (error: unknown) =>
      error instanceof ApiKeyError && error.statusCode === 403,
  );
  await assert.rejects(
    revokeApiKey(member, summary.id, database),
    (error: unknown) =>
      error instanceof ApiKeyError && error.statusCode === 403,
  );
});

test("an administrator can have only so many keys at once", async () => {
  const admin = await createUser();

  for (let index = 0; index < MAX_API_KEYS_PER_USER; index += 1) {
    await createApiKey(
      admin,
      { expiresInDays: null, name: `Key ${String(index)}`, scope: "read" },
      database,
    );
  }

  await assert.rejects(
    createApiKey(
      admin,
      { expiresInDays: null, name: "One too many", scope: "read" },
      database,
    ),
    (error: unknown) =>
      error instanceof ApiKeyError && error.statusCode === 409,
  );
});

test("every key that is not revoked stays in the list, however many are revoked after it", async () => {
  const admin = await createUser();
  const { summary: old } = await createApiKey(
    admin,
    { expiresInDays: null, name: "Oldest app", scope: "read" },
    database,
  );

  for (let index = 0; index < LISTED_REVOKED_API_KEYS + 10; index += 1) {
    const { summary } = await createApiKey(
      admin,
      { expiresInDays: null, name: `Spent ${String(index)}`, scope: "read" },
      database,
    );

    await revokeApiKey(admin, summary.id, database);
  }

  const listed = await listApiKeys(database);

  assert.ok(listed.some((row) => row.id === old.id));
  assert.equal(
    listed.filter((row) => row.revokedAt !== null).length,
    LISTED_REVOKED_API_KEYS,
  );
});

test(
  "a revocation by an administrator being removed at that moment waits, and is then refused",
  needsPostgresLocks,
  async () => {
    const leaving = await createUser();
    const other = await createUser();
    const { summary } = await createApiKey(
      other,
      { expiresInDays: null, name: "Their app", scope: "write" },
      database,
    );
    // The removal of the actor's role, under way but not yet committed.
    const holder = await database.connect();
    let revocation: Promise<unknown> | undefined;

    try {
      await holder.query("begin");
      await holder.query(`update "user" set role = 'user' where id = $1`, [
        leaving.userId,
      ]);

      revocation = revokeApiKey(leaving, summary.id, database);
      // Handled at once, so a failure before it waits is reported below
      // instead of as an unhandled rejection.
      revocation.catch(() => undefined);

      await waitUntilBlockedBy(database, holder);
      await holder.query("commit");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await revocation?.catch(() => undefined);
      holder.release();
    }

    await assert.rejects(
      revocation!,
      (error: unknown) =>
        error instanceof ApiKeyError && error.statusCode === 403,
    );

    const key = await database.query<{ revokedAt: number | null }>(
      `select revoked_at as "revokedAt" from api_keys where id = $1`,
      [summary.id],
    );

    assert.equal(key.rows[0]?.revokedAt, null);
  },
);

test(
  "removing an administrator takes the key rows before the audit lock, as revoking a key does",
  needsPostgresLocks,
  async () => {
    // revokeApiKey locks a key row and then the audit chain. Hold a key row
    // the way it does, and the role change must wait for it without already
    // holding the audit chain, or the two would deadlock.
    const stays = await createUser();
    const leaves = await createUser();
    const { summary } = await createApiKey(
      leaves,
      { expiresInDays: null, name: "Contested app", scope: "write" },
      database,
    );
    const holder = await database.connect();
    let roleChange: Promise<unknown> | undefined;

    try {
      await holder.query("begin");
      await holder.query(`select id from api_keys where id = $1 for update`, [
        summary.id,
      ]);

      roleChange = setPersonRole(stays.userId, leaves.userId, "user", database);
      // Handled at once, so a failure before it waits is reported below
      // instead of as an unhandled rejection.
      roleChange.catch(() => undefined);

      await waitUntilBlockedBy(database, holder);

      const free = await holder.query<{ locked: boolean }>(
        `select pg_try_advisory_xact_lock($1) as locked`,
        [SYSTEM_AUDIT_LOCK_ID],
      );

      assert.equal(free.rows[0]?.locked, true);
    } finally {
      // Let go of the key row whatever happened, and let the role change
      // finish before the connection goes back to the pool.
      await holder.query("rollback").catch(() => undefined);
      await roleChange?.catch(() => undefined);
      holder.release();
    }

    await roleChange;
  },
);
