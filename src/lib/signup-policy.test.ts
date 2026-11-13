import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeSignupPolicy,
  evaluateSignup,
  getEmailDomain,
  normalizeEmailDomain,
  parseEmailDomainList,
  suggestSignupPolicy,
} from "./signup-policy.ts";

test("a domain is tidied up, and anything else is turned away", () => {
  assert.equal(normalizeEmailDomain(" @Acme.com "), "acme.com");
  assert.equal(normalizeEmailDomain("mail.acme.co.uk"), "mail.acme.co.uk");
  assert.equal(normalizeEmailDomain("acme"), null);
  assert.equal(normalizeEmailDomain("jane@acme.com"), null);
  assert.equal(normalizeEmailDomain("-acme.com"), null);
  assert.equal(normalizeEmailDomain("*.acme.com"), null);
  assert.equal(normalizeEmailDomain(""), null);
});

test("the domain of an address is whatever follows the last @", () => {
  assert.equal(getEmailDomain("Jane@Acme.com"), "acme.com");
  assert.equal(getEmailDomain('"odd@name"@acme.com'), "acme.com");
  assert.equal(getEmailDomain("@acme.com"), null);
  assert.equal(getEmailDomain("jane"), null);
});

test("a typed list of domains is split, cleaned and de-duplicated", () => {
  assert.deepEqual(
    parseEmailDomainList("acme.com, @Acme.com;\n acme.co.uk  not a domain"),
    {
      domains: ["acme.co.uk", "acme.com"],
      invalid: ["not", "a", "domain"],
    },
  );
  assert.deepEqual(parseEmailDomainList(""), { domains: [], invalid: [] });
});

test("a new install starts with the administrator's own domain", () => {
  assert.deepEqual(suggestSignupPolicy("jane@acme.com"), {
    allowedEmailDomains: ["acme.com"],
    signupMode: "domains",
  });
});

test("a public mailbox domain does not open the install to everyone at it", () => {
  for (const email of ["jane@gmail.com", "jane@Outlook.com", "j@proton.me"]) {
    assert.deepEqual(suggestSignupPolicy(email), {
      allowedEmailDomains: [],
      signupMode: "closed",
    });
  }
});

test("open sign-up takes anyone", () => {
  assert.deepEqual(
    evaluateSignup("anyone@anywhere.example", {
      allowedEmailDomains: [],
      signupMode: "open",
    }),
    { allowed: true },
  );
});

test("domain sign-up takes addresses at the listed domains and no others", () => {
  const policy = {
    allowedEmailDomains: ["acme.com", "acme.co.uk"],
    signupMode: "domains" as const,
  };

  assert.deepEqual(evaluateSignup("Jane@ACME.com", policy), { allowed: true });
  assert.deepEqual(evaluateSignup("sam@acme.co.uk", policy), { allowed: true });

  // A subdomain, a look-alike and a domain hidden in the local part are
  // all somewhere else.
  for (const email of [
    "jane@mail.acme.com",
    "jane@notacme.com",
    "jane@acme.com.evil.example",
    "acme.com@evil.example",
    "not an address",
  ]) {
    assert.deepEqual(evaluateSignup(email, policy), {
      allowed: false,
      code: "signup_domain_not_allowed",
      message:
        "Accounts can be created with an email address at @acme.com or @acme.co.uk.",
    });
  }
});

test("closed sign-up takes nobody, and so does a domain rule with no domains", () => {
  for (const policy of [
    { allowedEmailDomains: ["acme.com"], signupMode: "closed" as const },
    { allowedEmailDomains: [], signupMode: "domains" as const },
  ]) {
    assert.deepEqual(evaluateSignup("jane@acme.com", policy), {
      allowed: false,
      code: "signup_closed",
      message: "New accounts are not being accepted.",
    });
  }
});

test("the rule is described in one sentence", () => {
  assert.equal(
    describeSignupPolicy({ allowedEmailDomains: [], signupMode: "open" }),
    "Anyone can create an account.",
  );
  assert.equal(
    describeSignupPolicy({
      allowedEmailDomains: ["a.com", "b.com", "c.com"],
      signupMode: "domains",
    }),
    "Accounts can be created with an email address at @a.com, @b.com or @c.com.",
  );
  assert.equal(
    describeSignupPolicy({ allowedEmailDomains: [], signupMode: "closed" }),
    "New accounts are not being accepted.",
  );
});
