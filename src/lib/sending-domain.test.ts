import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSenderAddress,
  isOwnableDomain,
  normalizeSubdomain,
  suggestSendingRootDomain,
} from "./sending-domain.ts";

test("only a domain an organization could own is offered for sending", () => {
  assert.equal(isOwnableDomain("kevinrose.com"), true);
  assert.equal(isOwnableDomain("mail.acme.co.uk"), true);
  assert.equal(isOwnableDomain("gmail.com"), false);
  assert.equal(isOwnableDomain("signudoc-abc.vercel.app"), false);
  assert.equal(isOwnableDomain("onboarding.resend.dev"), false);
  assert.equal(isOwnableDomain("localhost"), false);
  assert.equal(isOwnableDomain("127.0.0.1"), false);
});

test("the root domain comes from the site's custom domain, cut back to the email domain", () => {
  assert.equal(
    suggestSendingRootDomain({
      emails: ["kro@kevinrose.com"],
      siteHost: "esign.kevinrose.com",
    }),
    "kevinrose.com",
  );
  assert.equal(
    suggestSendingRootDomain({ siteHost: "sign.kevinrose.com" }),
    "kevinrose.com",
  );
  assert.equal(
    suggestSendingRootDomain({ siteHost: "documents.acme.com" }),
    "documents.acme.com",
  );
});

test("on a vercel.app address the emails decide, skipping public mailboxes", () => {
  assert.equal(
    suggestSendingRootDomain({
      emails: ["kro@gmail.com", "help@kevinrose.com"],
      siteHost: "signudoc-kro.vercel.app",
    }),
    "kevinrose.com",
  );
  assert.equal(
    suggestSendingRootDomain({
      emails: ["kro@gmail.com", ""],
      siteHost: "localhost",
    }),
    null,
  );
});

test("a subdomain is tidied up, and an empty one means the root domain", () => {
  assert.equal(normalizeSubdomain(" Sign. "), "sign");
  assert.equal(normalizeSubdomain("mail.sign"), "mail.sign");
  assert.equal(normalizeSubdomain(""), "");
  assert.equal(normalizeSubdomain("si gn"), null);
  assert.equal(normalizeSubdomain("-sign"), null);
});

test("the parts make one address, with sign. in front by default", () => {
  assert.deepEqual(
    buildSenderAddress({
      localPart: "Kro",
      rootDomain: "KevinRose.com",
      subdomain: "sign",
    }),
    {
      address: "kro@sign.kevinrose.com",
      error: null,
      sendingDomain: "sign.kevinrose.com",
    },
  );
  assert.deepEqual(
    buildSenderAddress({
      localPart: "kro",
      rootDomain: "kevinrose.com",
      subdomain: "",
    }),
    {
      address: "kro@kevinrose.com",
      error: null,
      sendingDomain: "kevinrose.com",
    },
  );
});

test("no domain means deciding later, and bad parts name their field", () => {
  assert.deepEqual(
    buildSenderAddress({ localPart: "x", rootDomain: " ", subdomain: "sign" }),
    { address: null, error: null },
  );
  assert.equal(
    buildSenderAddress({
      localPart: "x",
      rootDomain: "gmail.com",
      subdomain: "sign",
    }).error?.field,
    "rootDomain",
  );
  assert.equal(
    buildSenderAddress({
      localPart: "x",
      rootDomain: "acme.com",
      subdomain: "bad_sub",
    }).error?.field,
    "subdomain",
  );
  assert.equal(
    buildSenderAddress({
      localPart: "no spaces",
      rootDomain: "acme.com",
      subdomain: "sign",
    }).error?.field,
    "localPart",
  );
});
