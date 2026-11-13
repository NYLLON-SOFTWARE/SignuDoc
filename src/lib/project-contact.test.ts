import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// SignuDoc is run by whoever deploys it. The project keeps no site and no
// mailbox of its own, so nothing in the repository may send a person or a
// message to one. An install's contact address is the one its administrator
// gave at setup, and reports about the project itself go through GitHub.

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

// The domain the project once ran a hosted site on. Written in two parts
// so that this file does not name it either.
const formerHostedDomain = ["signudoc", "app"].join(".");

const SKIPPED_DIRECTORIES = new Set([
  ".data",
  ".git",
  ".next",
  ".vercel",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const TEXT_FILE =
  /\.(?:css|example|html|js|json|md|mjs|sql|ts|tsx|txt|yaml|yml)$/;

function listTextFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name)
        ? []
        : listTextFiles(entryPath);
    }

    return entry.isFile() && TEXT_FILE.test(entry.name) ? [entryPath] : [];
  });
}

test("nothing in the repository points at a site or a mailbox run by the project", () => {
  const files = listTextFiles(repoRoot);
  const offenders = files
    .filter((file) =>
      readFileSync(file, "utf8").toLowerCase().includes(formerHostedDomain),
    )
    .map((file) => path.relative(repoRoot, file));

  // The search really did look at the places an address used to be.
  for (const looked of ["SECURITY.md", "README.md", "src/lib/branding.ts"]) {
    assert.ok(files.includes(path.join(repoRoot, looked)), looked);
  }

  assert.deepEqual(offenders, []);
});

test("security and conduct reports go through GitHub, not to an email address", () => {
  for (const name of ["SECURITY.md", "CODE_OF_CONDUCT.md"]) {
    const text = readFileSync(path.join(repoRoot, name), "utf8");

    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, name);
    assert.doesNotMatch(text, /mailto:/i, name);
  }

  assert.ok(
    readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8").includes(
      "https://github.com/NYLLON-SOFTWARE/signudoc/security/advisories/new",
    ),
  );
  assert.match(
    readFileSync(path.join(repoRoot, "CODE_OF_CONDUCT.md"), "utf8"),
    /Report content/,
  );
});
