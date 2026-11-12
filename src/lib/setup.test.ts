import assert from "node:assert/strict";
import { test } from "node:test";

import type { DbPool } from "./db/connection.ts";
import { completeSetup, resolveSetupView, SetupError } from "./setup.ts";

const signedIn = {
  email: "jane@acme.com",
  emailVerified: true,
  id: "user_1",
};

test("a set-up install has nothing to show on the setup page", () => {
  assert.deepEqual(resolveSetupView({ status: "complete" }, { env: {} }), {
    view: "complete",
  });
});

test("a database without this version's tables says so", () => {
  assert.deepEqual(resolveSetupView({ status: "unmigrated" }, { env: {} }), {
    view: "unmigrated",
  });
});

test("the first visitor to a fresh install creates the administrator", () => {
  assert.deepEqual(resolveSetupView({ status: "fresh" }, { env: {} }), {
    requiresToken: false,
    senderAddressFromEnv: false,
    view: "create",
  });
});

test("a fresh install with SETUP_TOKEN asks for it", () => {
  assert.deepEqual(
    resolveSetupView(
      { status: "fresh" },
      {
        env: {
          RESEND_FROM_EMAIL: "sign@acme.com",
          SETUP_TOKEN: "a-secret-of-the-owner",
        },
      },
    ),
    { requiresToken: true, senderAddressFromEnv: true, view: "create" },
  );
});

test("an install with accounts but no administrator is claimed by someone signed in", () => {
  assert.deepEqual(
    resolveSetupView(
      { status: "unclaimed" },
      { env: { SETUP_TOKEN: "a-secret-of-the-owner" }, sessionUser: signedIn },
    ),
    { signedInEmail: "jane@acme.com", tokenConfigured: true, view: "claim" },
  );
  assert.deepEqual(resolveSetupView({ status: "unclaimed" }, { env: {} }), {
    signedInEmail: null,
    tokenConfigured: false,
    view: "claim",
  });
});

test("setup refuses input it cannot use before touching the database", async () => {
  // Any use of this stand-in database would throw.
  const database = {} as DbPool;
  const createAdminAccount = async () => {
    throw new Error("must not be reached");
  };

  await assert.rejects(
    completeSetup(
      { organizationName: "   ", senderAddress: "not an address" },
      { createAdminAccount, database, env: {} },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SetupError);
      assert.equal(error.statusCode, 400);
      assert.deepEqual(error.fieldErrors, {
        organizationName: "Enter the name of your organization",
        senderAddress: "Enter a valid email address, or leave this empty",
      });

      return true;
    },
  );
});
