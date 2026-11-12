import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// The "Deploy with Vercel" button in the README is one long link, and a
// slip in it is easy to make and hard to see. These tests read the link
// back and check what it asks Vercel to do.
// https://vercel.com/docs/deploy-button/source
// https://vercel.com/docs/deploy-button/demo

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");

function readDeployLink(): URL {
  const match = /\]\((https:\/\/vercel\.com\/new\/clone\?[^)\s]+)\)/.exec(
    readme,
  );

  assert.ok(match?.[1], "README.md has no Deploy with Vercel link");

  return new URL(match[1]);
}

test("the button copies this repository and pre-fills its name", () => {
  const link = readDeployLink();

  assert.equal(
    link.searchParams.get("repository-url"),
    "https://github.com/NYLLON-SOFTWARE/signudoc",
  );
  assert.equal(link.searchParams.get("project-name"), "signudoc");
  assert.equal(link.searchParams.get("repository-name"), "signudoc");
});

test("the button creates the database, the private file store and email", () => {
  const stores: unknown = JSON.parse(
    readDeployLink().searchParams.get("stores") ?? "null",
  );

  assert.deepEqual(stores, [
    {
      integrationSlug: "neon",
      productSlug: "neon",
      protocol: "storage",
      type: "integration",
    },
    // Private, so no document ever has a public address.
    { access: "private", type: "blob" },
    {
      integrationSlug: "resend",
      productSlug: "resend-email",
      protocol: "messaging",
      type: "integration",
    },
  ]);
});

test("the button asks for nothing to be typed in, and carries no values", () => {
  const link = readDeployLink();

  // Settings a person would have to type belong on the setup page, and a
  // default value in a public link is a secret shared with everyone.
  for (const parameter of ["env", "envDefaults", "envDescription", "envLink"]) {
    assert.equal(link.searchParams.has(parameter), false, parameter);
  }
});

test("the button's demo card is complete and its picture is in the repository", () => {
  const link = readDeployLink();

  // Vercel shows the card only when all four are there.
  for (const parameter of ["demo-title", "demo-description", "demo-url"]) {
    assert.ok(link.searchParams.get(parameter), parameter);
  }

  const image = link.searchParams.get("demo-image") ?? "";
  const prefix =
    "https://raw.githubusercontent.com/NYLLON-SOFTWARE/signudoc/main/";

  assert.ok(image.startsWith(prefix), image);
  assert.ok(existsSync(path.join(repoRoot, image.slice(prefix.length))));
});

test("every picture the README shows is in the repository", () => {
  const pictures = [...readme.matchAll(/!\[[^\]]*\]\((?!https?:)([^)\s]+)\)/g)];

  assert.ok(pictures.length > 0);

  for (const [, relativePath] of pictures) {
    assert.ok(
      existsSync(path.join(repoRoot, relativePath ?? "")),
      relativePath,
    );
  }
});
