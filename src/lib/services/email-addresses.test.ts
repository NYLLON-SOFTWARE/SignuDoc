import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildEmailAddresses,
  extractEmailAddress,
  getAddressDomain,
  isResendTestSender,
} from "./email-addresses.ts";

const base = {
  hosted: false,
  organizationName: "Acme Corp",
  senderAddress: null,
  supportAddress: null,
};

test("before a domain is set up, mail goes out from Resend's test address under the organization's name", () => {
  assert.deepEqual(buildEmailAddresses(base), {
    senderAddress: "Acme Corp <onboarding@resend.dev>",
    supportAddress: null,
  });
});

test("the organization's own address gets its name in front", () => {
  assert.deepEqual(
    buildEmailAddresses({
      ...base,
      senderAddress: " sign@acme.com ",
      supportAddress: " help@acme.com ",
    }),
    {
      senderAddress: "Acme Corp <sign@acme.com>",
      supportAddress: "help@acme.com",
    },
  );
});

test("a sender that already carries a display name is left alone", () => {
  assert.equal(
    buildEmailAddresses({
      ...base,
      senderAddress: "Acme Signing Desk <sign@acme.com>",
    }).senderAddress,
    "Acme Signing Desk <sign@acme.com>",
  );
});

test("characters that mean something in an email header are dropped from the name", () => {
  assert.equal(
    buildEmailAddresses({
      ...base,
      organizationName: 'Smith, Jones & "Co" <partners>\r\nBcc: x@evil.example',
    }).senderAddress,
    "Smith Jones & Co partners Bcc x evil.example <onboarding@resend.dev>",
  );
});

test("an install with no name, and the hosted service, send as SignuDoc", () => {
  assert.equal(
    buildEmailAddresses({ ...base, organizationName: null }).senderAddress,
    "SignuDoc <onboarding@resend.dev>",
  );
  assert.equal(
    buildEmailAddresses({ ...base, hosted: true }).senderAddress,
    "SignuDoc <onboarding@resend.dev>",
  );
});

test("the capture driver's fallback address is used when one is given", () => {
  assert.equal(
    buildEmailAddresses(base, "dev@signudoc.localhost").senderAddress,
    "Acme Corp <dev@signudoc.localhost>",
  );
});

test("the bare address and its domain can be read back out", () => {
  assert.equal(
    extractEmailAddress("Acme Corp <Sign@Acme.com>"),
    "sign@acme.com",
  );
  assert.equal(extractEmailAddress(" Sign@Acme.com "), "sign@acme.com");
  assert.equal(getAddressDomain("Acme Corp <sign@acme.com>"), "acme.com");
  assert.equal(getAddressDomain("not an address"), null);
  assert.equal(getAddressDomain("sign@"), null);
});

test("Resend's test address is recognized with or without a display name", () => {
  assert.equal(isResendTestSender("onboarding@resend.dev"), true);
  assert.equal(isResendTestSender("Acme <onboarding@resend.dev>"), true);
  assert.equal(isResendTestSender("sign@acme.com"), false);
  assert.equal(isResendTestSender("sign@notresend.dev"), false);
});
