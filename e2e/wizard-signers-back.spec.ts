import { expect, test } from "@playwright/test";

import { e2eDatabaseUrl } from "../playwright.config";
import { openE2eClient } from "./support/database";
import { signInAsAdministrator } from "./support/admin-session";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

async function countDrafts(title: string): Promise<number> {
  const database = openE2eClient(e2eDatabaseUrl);

  await database.connect();

  try {
    const result = await database.query<{ total: number }>(
      `select count(*)::int as total from envelopes where title = $1`,
      [title],
    );

    return result.rows[0]?.total ?? 0;
  } finally {
    await database.end();
  }
}

test("Back from Add signers stays in the same draft", async ({
  page,
}, testInfo) => {
  // A retry makes its own draft, so it counts only its own.
  const TITLE = `Back from signers ${String(testInfo.retry)}`;

  await signInAsAdministrator(page);

  const pdfPath = await writeSamplePdf(testInfo.outputPath("back.pdf"));

  await page.goto("/envelopes/new");
  await page.getByLabel("Envelope title").fill(TITLE);
  await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
  await page.getByRole("button", { name: "Next ->" }).click();
  await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

  const envelopeId =
    /\/envelopes\/([^/]+)\/signers$/.exec(page.url())?.[1] ?? "";

  await page.getByRole("link", { name: "← Back" }).click();

  // The draft's own page, not a blank upload form that would make another.
  await expect(page).toHaveURL(new RegExp(`/envelopes/${envelopeId}$`));
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue editing" }),
  ).toBeVisible();
  expect(await countDrafts(TITLE)).toBe(1);
});
