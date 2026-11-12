import assert from "node:assert/strict";
import { test } from "node:test";

import {
  duplicateRoleNameMessage,
  saveTemplateSchema,
  templateRolesSchema,
  useTemplateSchema,
} from "./template.ts";

test("a template needs a name, and its signers need different names", () => {
  assert.deepEqual(saveTemplateSchema.parse({ name: " Lease " }), {
    name: "Lease",
  });
  assert.equal(saveTemplateSchema.safeParse({ name: " " }).success, false);
  assert.equal(
    saveTemplateSchema.safeParse({ name: "Lease", roleNames: [] }).success,
    false,
  );
  assert.equal(
    saveTemplateSchema.safeParse({ name: "Lease", roleNames: ["x".repeat(61)] })
      .success,
    false,
  );

  const repeated = templateRolesSchema.safeParse([
    { id: "a", name: "Client" },
    { id: "b", name: "client" },
  ]);

  assert.equal(repeated.success, false);
  assert.equal(repeated.error?.issues[0]?.message, duplicateRoleNameMessage);
  assert.equal(
    templateRolesSchema.safeParse([
      { id: "a", name: "Client" },
      { id: "a", name: "Landlord" },
    ]).success,
    false,
  );
  assert.equal(templateRolesSchema.safeParse([]).success, false);
  assert.equal(
    templateRolesSchema.safeParse(
      Array.from({ length: 11 }, (_, index) => ({
        id: String(index),
        name: `Signer ${String(index)}`,
      })),
    ).success,
    false,
  );
});

test("using a template takes a title and one person for each signer", () => {
  const parsed = useTemplateSchema.parse({
    // Anything else about a signer is set on the draft afterwards.
    signers: [{ accessCode: "1234", email: " A@Example.com ", name: " Ann " }],
    title: " Lease ",
  });

  assert.deepEqual(parsed, {
    signers: [{ email: "A@Example.com", name: "Ann" }],
    title: "Lease",
  });
  assert.equal(
    useTemplateSchema.safeParse({
      signers: [
        { email: "a@example.com", name: "Ann" },
        { email: "A@example.com", name: "Bob" },
      ],
      title: "Lease",
    }).success,
    false,
  );
  assert.equal(
    useTemplateSchema.safeParse({ signers: [], title: "Lease" }).success,
    false,
  );
  assert.equal(
    useTemplateSchema.safeParse({
      signers: [{ email: "not an address", name: "Ann" }],
      title: "Lease",
    }).success,
    false,
  );
});
