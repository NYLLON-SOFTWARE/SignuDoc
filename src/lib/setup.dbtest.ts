import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  evaluateSignupRequest,
  invalidateSettingsCache,
  markEmailReady,
  readSetupState,
  readStoredSettings,
  saveSettings,
} from "./settings.ts";
import { completeSetup } from "./setup.ts";

// First-run setup and the sign-up rule against a real Postgres, where the
// order in which things become visible to other connections is the point.
// Run with `npm run test:db`.

const env = {};
const setupInput = {
  email: "owner@acme.com",
  fullName: "Olive Owner",
  organizationName: "Acme Corp",
  password: "a long enough passphrase",
};

let database: pg.Pool;

async function insertUser(email: string, role = "user"): Promise<string> {
  const id = randomUUID();

  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, $2, $3, $4)`,
    [id, "Someone", email, role],
  );

  return id;
}

async function countUsers(): Promise<number> {
  const result = await database.query<{ total: number }>(
    `select count(*)::int as total from public."user"`,
  );

  return result.rows[0]?.total ?? 0;
}

function signUp(email: string) {
  return evaluateSignupRequest(email, env, database);
}

before(async () => {
  database = await openTestDatabase();
});

beforeEach(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
});

after(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.app_settings");
  await database.end();
});

test("before setup nobody can sign up, and after it the chosen rule applies", async () => {
  assert.deepEqual(await signUp("owner@acme.com"), {
    allowed: false,
    code: "setup_required",
    message: "This site has not been set up yet.",
  });

  const result = await completeSetup(setupInput, {
    createAdminAccount: async ({ email }) => ({
      userId: await insertUser(email),
    }),
    database,
    env,
  });

  assert.equal(result.mode, "create");
  assert.deepEqual(await readSetupState(database), { status: "complete" });
  assert.deepEqual(await signUp("colleague@acme.com"), { allowed: true });
  assert.equal((await signUp("stranger@elsewhere.example")).allowed, false);
});

test("while the administrator's account is being created, nobody else can sign up", async () => {
  // The account is committed on its own connection before setup's
  // transaction commits. This is what a sign-up arriving in that gap, on
  // any other connection, is told.
  const duringSetup: unknown[] = [];

  await completeSetup(setupInput, {
    createAdminAccount: async ({ email }) => {
      const userId = await insertUser(email);

      duringSetup.push(await readSetupState(database));
      duringSetup.push(await signUp("stranger@elsewhere.example"));
      duringSetup.push(await signUp("colleague@acme.com"));

      return { userId };
    },
    database,
    env,
  });

  const refused = {
    allowed: false,
    code: "signup_closed",
    message: "New accounts are not being accepted.",
  };

  assert.deepEqual(duringSetup, [{ status: "unclaimed" }, refused, refused]);
});

test("a setup that fails halfway leaves sign-up closed, not open", async () => {
  const afterTheAccount: unknown[] = [];

  await assert.rejects(
    completeSetup(setupInput, {
      createAdminAccount: async ({ email }) => {
        await insertUser(email);

        throw new Error("the auth library gave up after making the account");
      },
      database,
      env,
    }),
    /gave up/,
  );

  // That account was not removed, because setup never learned its id. The
  // install has an account and no administrator, and must not be open.
  assert.equal(await countUsers(), 1);
  afterTheAccount.push(await readSetupState(database));
  afterTheAccount.push((await readStoredSettings(database))?.signupMode);
  afterTheAccount.push((await signUp("stranger@elsewhere.example")).allowed);

  assert.deepEqual(afterTheAccount, [{ status: "unclaimed" }, "closed", false]);
});

test("an install from before settings existed stays open until it is claimed", async () => {
  await insertUser("early@customer.example");

  assert.deepEqual(await readSetupState(database), { status: "unclaimed" });
  assert.equal(await readStoredSettings(database), null);
  assert.deepEqual(await signUp("anyone@anywhere.example"), { allowed: true });
});

test("a sign-up rule changed a moment ago applies at once", async () => {
  await insertUser("owner@acme.com", "admin");
  await saveSettings({ setupCompletedAt: 1, signupMode: "open" }, database);

  assert.deepEqual(await signUp("anyone@anywhere.example"), { allowed: true });

  // Changed behind the app's back, as another instance's save would be:
  // nothing here is told to forget what it had read.
  await database.query(
    "update public.app_settings set signup_mode = 'closed' where id",
  );

  assert.equal((await signUp("anyone@anywhere.example")).allowed, false);
});

test("an email check only vouches for the sender address it was made with", async () => {
  const readyAt = async () =>
    (await readStoredSettings(database))?.emailReadyAt ?? null;
  const checkedOld = {
    senderAddress: "old@acme.com",
    senderAddressFromEnv: false,
  };
  const checkedCurrent = {
    senderAddress: "sign@acme.com",
    senderAddressFromEnv: false,
  };

  await saveSettings(
    { senderAddress: "sign@acme.com", signupMode: "closed" },
    database,
  );

  // A check that started before the address was changed finishes late.
  await markEmailReady(true, checkedOld, database);
  assert.equal(await readyAt(), null);

  await markEmailReady(true, checkedCurrent, database);
  assert.notEqual(await readyAt(), null);

  // Nor can a stale failure take the mark away from the current address.
  await markEmailReady(false, checkedOld, database);
  assert.notEqual(await readyAt(), null);

  await markEmailReady(false, checkedCurrent, database);
  assert.equal(await readyAt(), null);

  // An address fixed by the environment is not the stored one, and cannot
  // change while a check runs, so its result is always recorded.
  await markEmailReady(
    true,
    { senderAddress: "Acme <env@acme.com>", senderAddressFromEnv: true },
    database,
  );
  assert.notEqual(await readyAt(), null);
});
