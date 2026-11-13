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
  brandColor: null,
  emailReadyAt: null,
  logoVersion: null,
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
  brand_color: stored.brandColor,
  email_ready_at: stored.emailReadyAt,
  logo_hash: stored.logoVersion,
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
function fakeDatabase(row = storedRow) {
  const saved: { values: unknown[] | null } = { values: null };
  const database = {
    query: (text: string, values: unknown[] = []) => {
      if (text.includes("insert into public.app_settings")) {
        saved.values = values;

        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      return Promise.resolve({ rowCount: 1, rows: [row] });
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

test("the support address can be changed, but not taken away", async () => {
  const current = resolveSettings(stored, {});

  for (const supportAddress of ["", "   ", null, undefined, "not an address"]) {
    const { database, saved } = fakeDatabase();

    await assert.rejects(
      updateOrganizationSettings(
        { ...form, supportAddress },
        current,
        database,
      ),
      (error: unknown) => {
        assert.ok(error instanceof OrganizationSettingsError);
        assert.deepEqual(error.fieldErrors, {
          supportAddress: "Enter an email address people can write to for help",
        });

        return true;
      },
    );
    assert.equal(saved.values, null);
  }

  const { database } = fakeDatabase();
  const result = await updateOrganizationSettings(
    { ...form, supportAddress: "Desk@Acme.com" },
    current,
    database,
  );

  assert.equal(result.supportAddress, "desk@acme.com");
});

test("an install whose support address comes from SUPPORT_EMAIL needs none of its own", async () => {
  const current = resolveSettings(
    { ...stored, supportAddress: null },
    { SUPPORT_EMAIL: "desk@acme.com" },
  );
  const { database, saved } = fakeDatabase({
    ...storedRow,
    support_address: null,
  });
  const result = await updateOrganizationSettings(
    { ...form, organizationName: "Acme Corporation", supportAddress: "" },
    current,
    database,
  );

  assert.equal(result.organizationName, "Acme Corporation");
  assert.equal(result.supportAddress, null);
  assert.ok(saved.values);
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

test("the brand color is stored as #rrggbb however it was typed, and empty clears it", async () => {
  const current = resolveSettings(stored, {});

  for (const [typed, expected] of [
    ["1A73E8", "#1a73e8"],
    ["#17e", "#1177ee"],
    [" #0b3d2e ", "#0b3d2e"],
    ["", null],
    [undefined, null],
  ] as const) {
    const { database } = fakeDatabase();
    const result = await updateOrganizationSettings(
      { ...form, brandColor: typed },
      current,
      database,
    );

    assert.equal(result.brandColor, expected, String(typed));
  }
});

test("something that is not a color is refused", async () => {
  const current = resolveSettings(stored, {});

  for (const brandColor of ["red", "#12345", "#fff;}body{display:none}", 7]) {
    const { database, saved } = fakeDatabase();

    await assert.rejects(
      updateOrganizationSettings({ ...form, brandColor }, current, database),
      (error: unknown) => {
        assert.ok(error instanceof OrganizationSettingsError);
        assert.deepEqual(Object.keys(error.fieldErrors), ["brandColor"]);

        return true;
      },
    );
    assert.equal(saved.values, null);
  }
});

test("the hosted service keeps its own color whatever the form sends", async () => {
  const current = resolveSettings(stored, { HOSTED_MODE: "1" });
  const { database } = fakeDatabase();
  const result = await updateOrganizationSettings(
    { ...form, brandColor: "not a color" },
    current,
    database,
  );

  assert.equal(result.brandColor, null);
});
