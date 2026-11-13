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
  resolveSettings,
  saveSettings,
} from "./settings.ts";
import { completeSetup, SetupError } from "./setup.ts";

// First-run setup and the sign-up rule against a real Postgres, where the
// order in which things become visible to other connections is the point.
// Run with `npm run test:db`.

const env = {};
const setupInput = {
  email: "owner@acme.com",
  fullName: "Olive Owner",
  organizationName: "Acme Corp",
  password: "a long enough passphrase",
  supportAddress: "help@acme.com",
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

test("the support address given at setup is saved for this install, not guessed", async () => {
  await completeSetup(
    { ...setupInput, supportAddress: "  Help@Acme.com " },
    {
      createAdminAccount: async ({ email }) => ({
        userId: await insertUser(email),
      }),
      database,
      env,
    },
  );

  const stored = await readStoredSettings(database);

  // The address that was typed, and not the administrator's own.
  assert.equal(stored?.supportAddress, "help@acme.com");
  assert.equal(resolveSettings(stored, env).supportAddress, "help@acme.com");
});

test("setup without a support address is refused before any account exists", async () => {
  const withoutSupportAddress: Record<string, string> = { ...setupInput };

  delete withoutSupportAddress.supportAddress;

  for (const input of [
    withoutSupportAddress,
    { ...setupInput, supportAddress: "   " },
  ]) {
    await assert.rejects(
      completeSetup(input, {
        createAdminAccount: async () => {
          throw new Error("no account may be created");
        },
        database,
        env,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SetupError);
        assert.equal(error.statusCode, 400);
        assert.deepEqual(error.fieldErrors, {
          supportAddress: "Enter an email address people can write to for help",
        });

        return true;
      },
    );
  }

  // Nothing was left behind: the next visitor starts from the beginning.
  assert.equal(await countUsers(), 0);
  assert.equal(await readStoredSettings(database), null);
  assert.deepEqual(await readSetupState(database), { status: "fresh" });

  // Every field that needs attention is named at once.
  await assert.rejects(
    completeSetup(
      { ...withoutSupportAddress, password: "too short" },
      {
        createAdminAccount: async () => {
          throw new Error("no account may be created");
        },
        database,
        env,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SetupError);
      assert.deepEqual(Object.keys(error.fieldErrors).sort(), [
        "password",
        "supportAddress",
      ]);

      return true;
    },
  );
});

test("a deployment that sets SUPPORT_EMAIL is not asked for a support address", async () => {
  const fixed = { SUPPORT_EMAIL: "Acme Help <desk@acme.com>" };
  const withoutSupportAddress: Record<string, string> = { ...setupInput };

  delete withoutSupportAddress.supportAddress;

  await completeSetup(withoutSupportAddress, {
    createAdminAccount: async ({ email }) => ({
      userId: await insertUser(email),
    }),
    database,
    env: fixed,
  });

  const stored = await readStoredSettings(database);

  // Nothing is saved in its place, and the deployment's address is in use.
  assert.equal(stored?.supportAddress, null);
  assert.equal(
    resolveSettings(stored, fixed).supportAddress,
    "Acme Help <desk@acme.com>",
  );
});

test("someone who takes charge of an older install gives it a support address, unless it has one", async () => {
  const claimEnv = { SETUP_TOKEN: "a-secret-of-the-owner" };
  const claim = {
    organizationName: "Second Wind Partners",
    setupToken: claimEnv.SETUP_TOKEN,
  };
  const userId = await insertUser("early@customer.example");
  const sessionUser = {
    email: "early@customer.example",
    emailVerified: true,
    id: userId,
  };
  const createAdminAccount = async () => {
    throw new Error("nobody is created when an install is claimed");
  };
  const options = { createAdminAccount, database, env: claimEnv, sessionUser };

  await assert.rejects(completeSetup(claim, options), (error: unknown) => {
    assert.ok(error instanceof SetupError);
    assert.equal(error.statusCode, 400);
    assert.deepEqual(Object.keys(error.fieldErrors), ["supportAddress"]);

    return true;
  });
  // Still nobody in charge, and nothing saved.
  assert.deepEqual(await readSetupState(database), { status: "unclaimed" });
  assert.equal(await readStoredSettings(database), null);

  await completeSetup(
    { ...claim, supportAddress: "desk@customer.example" },
    options,
  );

  assert.deepEqual(await readSetupState(database), { status: "complete" });
  assert.equal(
    (await readStoredSettings(database))?.supportAddress,
    "desk@customer.example",
  );

  // The same install with nobody in charge again: the address it was
  // given is kept, and is not asked for a second time.
  await database.query(`update public."user" set role = 'user'`);
  invalidateSettingsCache();
  await completeSetup(claim, options);

  assert.deepEqual(await readSetupState(database), { status: "complete" });
  assert.equal(
    (await readStoredSettings(database))?.supportAddress,
    "desk@customer.example",
  );
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

test(
  "submissions that arrive together get one winner, and the rest are turned away at once",
  { timeout: 20_000 },
  async () => {
    // As many at once as the pool has connections. If the losers waited
    // for the winner, each would hold a connection while it did, and the
    // winner would have none left to create the account with.
    const submissions = Array.from({ length: 12 }, (_, index) =>
      completeSetup(
        { ...setupInput, email: `owner${index}@acme.com` },
        {
          createAdminAccount: async ({ email }) => ({
            userId: await insertUser(email),
          }),
          database,
          env,
        },
      ),
    );
    const outcomes = await Promise.allSettled(submissions);
    const winners = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const refusals = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason as unknown] : [],
    );

    assert.equal(winners.length, 1);
    assert.equal(refusals.length, 11);

    for (const refusal of refusals) {
      assert.ok(refusal instanceof SetupError);
      assert.equal(refusal.statusCode, 409);
    }

    assert.equal(await countUsers(), 1);
    assert.deepEqual(await readSetupState(database), { status: "complete" });
  },
);

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

test("a database that is behind this version still applies its sign-up rule", async () => {
  await insertUser("owner@acme.com", "admin");
  await saveSettings(
    {
      organizationName: "Acme Corp",
      retentionDays: 365,
      setupCompletedAt: 1,
      signupMode: "closed",
    },
    database,
  );

  // Takes a column this version reads out of the table, as if its
  // migration had not run. Whatever happens below, it is put back.
  const hidden: string[] = [];
  const hide = async (column: string) => {
    await database.query(
      `alter table public.app_settings rename column ${column} to ${column}_later`,
    );
    hidden.push(column);
  };

  try {
    // The table as it was before an install could have its own color.
    await hide("brand_color");

    const beforeBranding = await readStoredSettings(database);

    assert.equal(beforeBranding?.signupMode, "closed");
    assert.equal(beforeBranding?.organizationName, "Acme Corp");
    assert.equal(beforeBranding?.brandColor, null);
    // What that table does hold still counts.
    assert.equal(beforeBranding?.retentionDays, 365);
    assert.equal((await signUp("anyone@anywhere.example")).allowed, false);

    // And as it was created, before a retention period could be set.
    await hide("retention_days");

    const asCreated = await readStoredSettings(database);

    assert.equal(asCreated?.signupMode, "closed");
    assert.equal(asCreated?.retentionDays, null);
    assert.equal((await signUp("anyone@anywhere.example")).allowed, false);
  } finally {
    for (const column of hidden.reverse()) {
      await database.query(
        `alter table public.app_settings rename column ${column}_later to ${column}`,
      );
    }
  }
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
