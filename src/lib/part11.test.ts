import assert from "node:assert/strict";
import { test } from "node:test";

import { toCsv } from "./audit-export.ts";
import { describePart11SignerProblem } from "./part11.ts";
import { computeSystemAuditRowHash } from "./services/system-audit.ts";
import {
  buildSignatureManifestation,
  parseSignatureMeaning,
} from "./signature-meanings.ts";
import { requiredSignerChecks } from "./signer-checks.ts";

// Part 11 mode's pure parts: the line printed beside a signature, the CSV
// export, the reasons a send is refused and the install audit hash.

test("the manifestation gives the name, the UTC time and the meaning", () => {
  assert.equal(
    buildSignatureManifestation({
      name: "Ada Lovelace",
      signatureMeaning: "approval",
      signedAt: Date.UTC(2026, 10, 13, 9, 5, 7) / 1000,
    }),
    "Signed by Ada Lovelace | 2026-11-13 09:05:07 UTC | Meaning: Approval",
  );
});

test("only the four Part 11 meanings parse", () => {
  assert.equal(parseSignatureMeaning("review"), "review");
  assert.equal(parseSignatureMeaning("authorship"), "authorship");
  assert.equal(parseSignatureMeaning("Approval"), null);
  assert.equal(parseSignatureMeaning(undefined), null);
});

test("a CSV cell never runs as a spreadsheet formula and quotes are escaped", () => {
  const csv = toCsv([
    ['=HYPERLINK("x")', "+1", "-2", "@cmd", "plain"],
    ['say "hi", then', { a: 1 }, null],
  ]);

  assert.equal(
    csv,
    `"'=HYPERLINK(""x"")",'+1,'-2,'@cmd,plain\r\n"say ""hi"", then","{""a"":1}",\r\n`,
  );
});

test("a send is refused for each missing Part 11 condition, in order", () => {
  const signer = { email: "a@example.test", name: "Ada" };
  const ready = {
    email: "a@example.test",
    emailVerified: true,
    identityVerifiedAt: 1,
    name: "Ada",
    signingLockedAt: null,
    userId: "u1",
  };

  assert.match(
    describePart11SignerProblem(signer, undefined) ?? "",
    /needs an account/,
  );
  assert.match(
    describePart11SignerProblem(signer, { ...ready, emailVerified: false }) ??
      "",
    /not confirmed their email/,
  );
  assert.match(
    describePart11SignerProblem(signer, {
      ...ready,
      identityVerifiedAt: null,
    }) ?? "",
    /confirm Ada's identity/,
  );
  assert.match(
    describePart11SignerProblem(signer, { ...ready, signingLockedAt: 5 }) ?? "",
    /locked for signing/,
  );
  assert.match(
    describePart11SignerProblem(signer, ready) ?? "",
    /Choose what Ada's signature means/,
  );
  assert.equal(
    describePart11SignerProblem(
      { ...signer, signatureMeaning: "approval" },
      ready,
    ),
    null,
  );
});

test("a signer bound to an account must pass the account check first", () => {
  assert.deepEqual(
    requiredSignerChecks({
      accessCodeHash: null,
      accountUserId: "u1",
      requireEmailCode: true,
    }),
    ["account", "email_code"],
  );
});

test("the install audit hash changes when any field or the previous hash does", () => {
  const fields = {
    actorEmail: "admin@example.test",
    actorUserId: "a1",
    createdAt: 100,
    event: "role_changed" as const,
    id: "e1",
    ipAddress: null,
    metadata: { from: "user", to: "admin" },
    sequence: 1,
    targetUserId: "u1",
    userAgent: null,
  };
  const hash = computeSystemAuditRowHash(null, fields);

  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(computeSystemAuditRowHash(null, { ...fields }), hash);
  assert.notEqual(computeSystemAuditRowHash("x", fields), hash);
  assert.notEqual(
    computeSystemAuditRowHash(null, {
      ...fields,
      metadata: { from: "user", to: "user" },
    }),
    hash,
  );
});
