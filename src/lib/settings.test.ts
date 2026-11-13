import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBranding } from "./branding.ts";
import {
  isMissingSchemaError,
  resolveSettings,
  type AppSettings,
} from "./settings.ts";

const stored: AppSettings = {
  allowedEmailDomains: ["acme.com"],
  brandColor: null,
  emailReadyAt: null,
  logoVersion: null,
  organizationName: "Acme Corp",
  privacyUrl: "https://acme.com/privacy",
  retentionDays: null,
  senderAddress: "sign@acme.com",
  setupCompletedAt: 1_800_000_000,
  signupMode: "domains",
  supportAddress: "help@acme.com",
  termsUrl: "https://acme.com/terms",
};

test("an install with no settings row behaves as it did before settings existed", () => {
  const settings = resolveSettings(null, {});

  assert.equal(settings.signupMode, "open");
  assert.equal(settings.organizationName, null);
  assert.equal(settings.senderAddress, null);
  assert.equal(settings.hosted, false);
});

test("stored settings are used as they are when the environment says nothing", () => {
  const settings = resolveSettings(stored, {});

  assert.equal(settings.senderAddress, "sign@acme.com");
  assert.equal(settings.senderAddressFromEnv, false);
  assert.equal(settings.supportAddress, "help@acme.com");
  assert.equal(settings.supportAddressFromEnv, false);
});

test("email addresses set in the environment win over the stored ones", () => {
  const settings = resolveSettings(stored, {
    RESEND_FROM_EMAIL: "Acme Signing <noreply@mail.acme.com>",
    SUPPORT_EMAIL: "desk@acme.com",
  });

  assert.equal(settings.senderAddress, "Acme Signing <noreply@mail.acme.com>");
  assert.equal(settings.senderAddressFromEnv, true);
  assert.equal(settings.supportAddress, "desk@acme.com");
  assert.equal(settings.supportAddressFromEnv, true);
});

test("hosted mode is switched on by HOSTED_MODE", () => {
  assert.equal(resolveSettings(null, { HOSTED_MODE: "1" }).hosted, true);
  assert.equal(resolveSettings(null, { HOSTED_MODE: "true" }).hosted, true);
  assert.equal(resolveSettings(null, { HOSTED_MODE: "0" }).hosted, false);
  assert.equal(resolveSettings(null, { HOSTED_MODE: "" }).hosted, false);
});

test("a neutral install goes by the organization's name and links", () => {
  assert.deepEqual(buildBranding(resolveSettings(stored, {})), {
    brandColor: null,
    contactUrl: null,
    hosted: false,
    logoUrl: null,
    organizationName: "Acme Corp",
    privacyUrl: "https://acme.com/privacy",
    productName: "Acme Corp",
    signupAvailable: true,
    supportAddress: "help@acme.com",
    termsUrl: "https://acme.com/terms",
  });
});

test("a neutral install with no name yet goes by SignuDoc and has no legal links", () => {
  const branding = buildBranding(resolveSettings(null, {}));

  assert.equal(branding.productName, "SignuDoc");
  assert.equal(branding.organizationName, null);
  assert.equal(branding.termsUrl, null);
  assert.equal(branding.privacyUrl, null);
  assert.equal(branding.contactUrl, null);
});

test("hosted mode keeps SignuDoc's own name and pages whatever is stored", () => {
  const branding = buildBranding(resolveSettings(stored, { HOSTED_MODE: "1" }));

  assert.equal(branding.hosted, true);
  assert.equal(branding.productName, "SignuDoc");
  assert.equal(branding.organizationName, null);
  assert.equal(branding.termsUrl, "/terms");
  assert.equal(branding.privacyUrl, "/privacy");
  assert.equal(branding.contactUrl, "/contact");
  assert.equal(branding.supportAddress, "help@acme.com");
});

test("sign-up is offered only when someone could actually sign up", () => {
  const available = (update: Partial<AppSettings>) =>
    buildBranding(resolveSettings({ ...stored, ...update }, {}))
      .signupAvailable;

  assert.equal(available({ signupMode: "open" }), true);
  assert.equal(available({ signupMode: "domains" }), true);
  assert.equal(
    available({ allowedEmailDomains: [], signupMode: "domains" }),
    false,
  );
  assert.equal(available({ signupMode: "closed" }), false);
});

test("a missing table or column is recognized, other failures are not", () => {
  assert.equal(isMissingSchemaError({ code: "42P01" }), true);
  assert.equal(isMissingSchemaError({ code: "42703" }), true);
  assert.equal(isMissingSchemaError({ code: "23505" }), false);
  assert.equal(isMissingSchemaError(new Error("connection refused")), false);
  assert.equal(isMissingSchemaError(null), false);
});

test("a neutral install carries its own color and logo, hosted mode never does", () => {
  const branded: AppSettings = {
    ...stored,
    brandColor: "#1a73e8",
    logoVersion: "0123456789abcdef",
  };
  const neutral = buildBranding(resolveSettings(branded, {}));

  assert.equal(neutral.brandColor, "#1a73e8");
  assert.equal(neutral.logoUrl, "/api/brand/logo?v=0123456789abcdef");

  const plain = buildBranding(resolveSettings(stored, {}));

  assert.equal(plain.brandColor, null);
  assert.equal(plain.logoUrl, null);

  const hosted = buildBranding(resolveSettings(branded, { HOSTED_MODE: "1" }));

  assert.equal(hosted.brandColor, null);
  assert.equal(hosted.logoUrl, null);
});

test("a stored color that is not one is ignored rather than put on a page", () => {
  const branding = buildBranding(
    resolveSettings({ ...stored, brandColor: "red;}body{display:none" }, {}),
  );

  assert.equal(branding.brandColor, null);
});
