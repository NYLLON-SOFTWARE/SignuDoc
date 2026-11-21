import { expect, type Page, test } from "@playwright/test";

import { e2eDatabaseUrl } from "../playwright.config";
import { openE2eClient } from "./support/database";
import { signInAsAdministrator } from "./support/admin-session";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

const TITLE = "SAMPLE - Supplier Agreement (view while out)";
const SIGNER_EMAIL = "valentina.view@example.com";
const OTHER_MEMBER_ID = "e2e-view-document-member";
const OTHER_MEMBER_EMAIL = "morgan.member@example.com";

async function expectTheDocumentAsSent(page: Page, documentUrl: string) {
  const response = await page.request.get(documentUrl);

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect((await response.body()).subarray(0, 5).toString("latin1")).toBe(
    "%PDF-",
  );
}

async function countOriginalViews(envelopeId: string): Promise<number> {
  const database = openE2eClient(e2eDatabaseUrl);

  await database.connect();

  try {
    const result = await database.query<{ count: string }>(
      `
        select count(*) as count
        from public.system_audit_events
        where event = 'envelope_file_downloaded'
          and metadata->>'envelopeId' = $1
          and metadata->>'file' = 'original'
      `,
      [envelopeId],
    );

    return Number(result.rows[0]?.count ?? "0");
  } finally {
    await database.end();
  }
}

test("a sender opens the document while it is out for signature, and after voiding it", async ({
  page,
}, testInfo) => {
  let envelopeId = "";
  const documentUrl = () => `/api/envelopes/${envelopeId}/document`;

  await signInAsAdministrator(page);

  await test.step("the sender sends a document", async () => {
    const pdfPath = await writeSamplePdf(testInfo.outputPath("view.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill(TITLE);
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);
    envelopeId = /\/envelopes\/([^/]+)\/signers$/.exec(page.url())?.[1] ?? "";

    await page.getByLabel("Signer 1 name").fill("Valentina View");
    await page.getByLabel("Signer 1 email").fill(SIGNER_EMAIL);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);
    await page.getByRole("button", { exact: true, name: "Signature" }).click();

    const placementTarget = page.getByLabel("Place Signature on page 1");
    const box = await placementTarget.boundingBox();

    await placementTarget.click({
      position: { x: box!.width * 0.3, y: box!.height * 0.6 },
    });
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();
    await expect(page).toHaveURL(new RegExp(`/envelopes/${envelopeId}$`));
  });

  await test.step("while it is out, View document and the thumbnail open it in a new tab", async () => {
    const viewButton = page.getByRole("link", { name: "View document" });

    await expect(viewButton).toBeVisible();
    await expect(viewButton).toHaveAttribute("href", documentUrl());
    await expect(viewButton).toHaveAttribute("target", "_blank");
    await expect(viewButton).toHaveAttribute("rel", /noopener/);

    const thumbnailLink = page.getByRole("link", {
      name: `View ${TITLE} (opens in a new tab)`,
    });

    await expect(thumbnailLink).toBeVisible();
    await expect(thumbnailLink).toHaveAttribute("href", documentUrl());
    await expect(thumbnailLink).toHaveAttribute("target", "_blank");

    // Clicking each one opens a new tab on the document and leaves this
    // page where it was.
    for (const link of [viewButton, thumbnailLink]) {
      const documentResponse = page
        .context()
        .waitForEvent(
          "response",
          (response) =>
            new URL(response.url()).pathname === documentUrl() &&
            response.request().resourceType() === "document",
        );
      const popupOpened = page.waitForEvent("popup");

      await link.click();

      const popup = await popupOpened;

      expect((await documentResponse).status()).toBe(200);
      expect(popup).not.toBe(page);
      await expect(page).toHaveURL(new RegExp(`/envelopes/${envelopeId}$`));
      await popup.close();
    }

    await expectTheDocumentAsSent(page, documentUrl());
    // The sender looking at their own document is nothing to record.
    expect(await countOriginalViews(envelopeId)).toBe(0);
  });

  await test.step("once voided, it can still be opened", async () => {
    await page.getByRole("button", { name: "Void envelope" }).click();

    const voidDialog = page.getByRole("dialog", {
      name: "Void this envelope?",
    });

    await voidDialog.getByRole("textbox").fill("Wrong supplier name.");
    await voidDialog.getByRole("button", { name: "Void envelope" }).click();
    await expect(
      page.getByText("Voided", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "View document" }),
    ).toHaveAttribute("href", documentUrl());
    await expectTheDocumentAsSent(page, documentUrl());
  });

  await test.step("an administrator opening another member's document is on record", async () => {
    const database = openE2eClient(e2eDatabaseUrl);

    await database.connect();

    try {
      await database.query(
        `
          insert into public."user" (id, name, email, "emailVerified")
          values ($1, 'Morgan Member', $2, true)
          on conflict (id) do nothing
        `,
        [OTHER_MEMBER_ID, OTHER_MEMBER_EMAIL],
      );
      await database.query(`update envelopes set user_id = $1 where id = $2`, [
        OTHER_MEMBER_ID,
        envelopeId,
      ]);
    } finally {
      await database.end();
    }

    await page.goto(`/envelopes/${envelopeId}`);
    await expect(page.getByText(/Sent by Morgan Member/)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "View document" }),
    ).toHaveAttribute("href", documentUrl());

    const before = await countOriginalViews(envelopeId);

    await expectTheDocumentAsSent(page, documentUrl());
    expect(await countOriginalViews(envelopeId)).toBe(before + 1);
  });
});
