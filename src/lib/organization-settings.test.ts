import assert from "node:assert/strict";
import { test } from "node:test";

import type { DbExecutor } from "./db/connection.ts";
import {
  OrganizationSettingsError,
  updateOrganizationSettings,
} from "./organization-settings.ts";
import { resolveSettings, type AppSettings } from "./settings.ts";

const stored: AppSettings = {
  allowedEmailDomains: ["acme.com"],
  emailReadyAt: null,
  organizationName: "Acme Corp",
  privacyUrl: null,
  retentionDays: null,
  senderAddress: "sign@acme.com",
  setupCompletedAt: 1_800_000_000,
  signupMode: "domains",
  supportAddress: "help@acme.com",
  termsUrl: null,
};

const storedRow = {
  allowed_email_domains: stored.allowedEmailDomains,
  email_ready_at: stored.emailReadyAt,
  organization_name: stored.organizationName,
  privacy_url: stored.privacyUrl,
  retention_days: stored.retentionDays,
  sender_address: stored.senderAddress,
  setup_completed_at: stored.setupCompletedAt,
  signup_mode: stored.signupMode,
  support_address: stored.supportAddress,
  terms_url: stored.termsUrl,
};

/**
 * Stands in for the database: answers the read with the stored row and
 * keeps what the save was asked to write.
 */
function fakeDatabase() {
  const saved: { values: unknown[] | null } = { values: null };
  const database = {
    query: (text: string, values: unknown[] = []) => {
      if (text.includes("insert into public.app_settings")) {
        saved.values = values;

        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      return Promise.resolve({ rowCount: 1, rows: [storedRow] });
    },
  } as unknown as DbExecutor;

  return { database, saved };
}

// What the form sends: every field, as it is shown.
const form = {
  allowedEmailDomains: "acme.com",
  organizationName: "Acme Corp",
  privacyUrl: "",
  senderAddress: "sign@acme.com",
  signupMode: "domains",
  supportAddress: "help@acme.com",
  termsUrl: "",
};

test("a sender fixed by the environment, display name and all, does not block saving the rest", async () => {
  const env = { RESEND_FROM_EMAIL: "Acme Signing <sign@acme.com>" };
  const current = resolveSettings(stored, env);
  const { database, saved } = fakeDatabase();
  const result = await updateOrganizationSettings(
    {
      ...form,
      organizationName: "Acme Corporation",
      // The locked field comes back exactly as it was displayed.
      senderAddress: "Acme Signing <sign@acme.com>",
    },
    current,
    database,
  );

  assert.equal(result.organizationName, "Acme Corporation");
  // The stored sender is left as it was: the one in use is the environment's.
  assert.equal(result.senderAddress, "sign@acme.com");
  assert.ok(saved.values);
});

test("a support address fixed by the environment is not judged or changed either", async () => {
  const current = resolveSettings(stored, { SUPPORT_EMAIL: "desk@acme.com" });
  const { database } = fakeDatabase();
  const result = await updateOrganizationSettings(
    { ...form, supportAddress: "not an address" },
    current,
    database,
  );

  assert.equal(result.supportAddress, "help@acme.com");
});

test("an address the administrator can edit is still checked", async () => {
  const current = resolveSettings(stored, {});
  const { database, saved } = fakeDatabase();

  await assert.rejects(
    updateOrganizationSettings(
      { ...form, senderAddress: "Acme Signing <sign@acme.com>" },
      current,
      database,
    ),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationSettingsError);
      assert.deepEqual(Object.keys(error.fieldErrors), ["senderAddress"]);

      return true;
    },
  );
  assert.equal(saved.values, null);
});

test("what is left in the hidden domain field does not block closing or opening sign-up", async () => {
  const current = resolveSettings(stored, {});

  for (const signupMode of ["closed", "open"]) {
    const { database } = fakeDatabase();
    const result = await updateOrganizationSettings(
      { ...form, allowedEmailDomains: "not a domain, ???", signupMode },
      current,
      database,
    );

    assert.equal(result.signupMode, signupMode);
    // The list from before is kept for when the rule is switched back.
    assert.deepEqual(result.allowedEmailDomains, ["acme.com"]);
  }
});

test("under the domain rule the list is checked and saved", async () => {
  const current = resolveSettings(stored, {});
  const accepted = fakeDatabase();
  const result = await updateOrganizationSettings(
    { ...form, allowedEmailDomains: "acme.com, Acme.co.uk" },
    current,
    accepted.database,
  );

  assert.deepEqual(result.allowedEmailDomains, ["acme.co.uk", "acme.com"]);

  for (const allowedEmailDomains of ["not a domain", ""]) {
    const refused = fakeDatabase();

    await assert.rejects(
      updateOrganizationSettings(
        { ...form, allowedEmailDomains },
        current,
        refused.database,
      ),
      (error: unknown) => {
        assert.ok(error instanceof OrganizationSettingsError);
        assert.deepEqual(Object.keys(error.fieldErrors), [
          "allowedEmailDomains",
        ]);

        return true;
      },
    );
    assert.equal(refused.saved.values, null);
  }
});
