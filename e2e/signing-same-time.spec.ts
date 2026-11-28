import { expect, type Browser, test } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { extractLink, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

const SIGNERS = [
  { email: "avery.together@example.com", name: "Avery Together" },
  { email: "blake.together@example.com", name: "Blake Together" },
  { email: "casey.after@example.com", name: "Casey After" },
] as const;
const INVITATION_SUBJECT = "Please review our agreement";
const INVITATION_MESSAGE = "Please review the work & schedule.\nThank you.";

/** Opens a signer's invitation, applies their signature and finishes. */
async function signFromInvitation(browser: Browser, email: string) {
  const invitation = await waitForEmail({
    template: "signing_invitation",
    to: email,
  });
  expect(invitation.subject).toBe(INVITATION_SUBJECT);
  expect(invitation.text).toContain(INVITATION_MESSAGE);
  expect(invitation.html).toContain("work &amp; schedule.");
  const context = await browser.newContext({
    viewport: { height: 900, width: 1440 },
  });
  const signerPage = await context.newPage();

  await signerPage.goto(extractLink(invitation.text, "/sign/"));

  const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

  await consent
    .getByRole("checkbox", {
      name: "I agree to use electronic records and signatures",
    })
    .check();
  await consent.getByRole("button", { name: "Agree and continue" }).click();
  await expect(consent).toBeHidden();
  await signerPage
    .getByRole("button", { exact: true, name: "Signature" })
    .click();
  await signerPage
    .getByRole("dialog", { name: "Add your signature" })
    .getByRole("button", { name: "Apply signature" })
    .click();
  await signerPage.getByRole("button", { name: "Finish" }).click();
  await signerPage
    .getByRole("dialog", { name: "Finish signing?" })
    .getByRole("button", { name: "Finish signing" })
    .click();
  await expect(signerPage).toHaveURL(/\/sign\/[^/]+\/done/);
  await context.close();
}

async function waitForNoEmail(input: { template: string; to: string }) {
  await expect(waitForEmail(input, 1_500)).rejects.toThrow(/No "/);
}

test("two signers of one step sign in any order, then the next step is invited", async ({
  browser,
  page,
}, testInfo) => {
  await test.step("the sender puts the first two signers in one step", async () => {
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("together.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Signing at the same time");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    for (const [index, signer] of SIGNERS.entries()) {
      if (index > 0) {
        await page
          .getByRole("button", { name: "+ Add another signer" })
          .click();
      }

      await page
        .getByLabel(`Signer ${String(index + 1)} name`)
        .fill(signer.name);
      await page
        .getByLabel(`Signer ${String(index + 1)} email`)
        .fill(signer.email);
    }

    await page
      .getByRole("checkbox", { name: "Sign at the same time as Signer 1" })
      .check();
    await expect(
      page.getByRole("checkbox", { name: "Sign at the same time as Signer 2" }),
    ).not.toBeChecked();
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    const placementTarget = page.getByLabel("Place Signature on page 1");

    for (const [index, signer] of SIGNERS.entries()) {
      await page
        .getByRole("button", {
          name: new RegExp(`${signer.name} \\d+ fields? placed`),
        })
        .click();
      await page
        .getByRole("button", { exact: true, name: "Signature" })
        .click();

      const box = await placementTarget.boundingBox();

      await placementTarget.click({
        position: {
          x: box!.width * 0.3,
          y: box!.height * (0.2 + index * 0.25),
        },
      });
      await expect(page.getByRole("status")).toHaveText("Saved");
    }

    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);
    await expect(
      page.getByText("everyone numbered 1 receives an email", { exact: false }),
    ).toBeVisible();
    await page.getByLabel("Email subject (optional)").fill(INVITATION_SUBJECT);
    await page.getByLabel("Email message (optional)").fill(INVITATION_MESSAGE);
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await expect(confirmation).toContainText(
      "Avery Together and Blake Together will be notified immediately, to sign at the same time.",
    );
    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+$/);
  });

  await test.step("both of the first step are invited, the third is not yet", async () => {
    await waitForEmail({
      template: "signing_invitation",
      to: SIGNERS[0].email,
    });
    await waitForEmail({
      template: "signing_invitation",
      to: SIGNERS[1].email,
    });
    await waitForNoEmail({
      template: "signing_invitation",
      to: SIGNERS[2].email,
    });
    if (process.env.SIGNUDOC_EMAIL_ORDERED_SIGNING_STARTED === "1") {
      const notice = await waitForEmail({
        template: "ordered_signing_started",
        to: SIGNERS[2].email,
      });
      expect(notice.text).toContain("when it is your turn");
      expect(notice.text).not.toContain("/sign/");
      expect(notice.attachments ?? []).toHaveLength(0);
    }
  });

  await test.step("the second signer signs first; the third still waits", async () => {
    await signFromInvitation(browser, SIGNERS[1].email);
    await waitForNoEmail({
      template: "signing_invitation",
      to: SIGNERS[2].email,
    });
  });

  await test.step("once the first signs too, the third is invited and finishes it", async () => {
    await signFromInvitation(browser, SIGNERS[0].email);
    await signFromInvitation(browser, SIGNERS[2].email);
    await waitForEmail({
      template: "completion_notification",
      to: SIGNERS[2].email,
    });
  });
});
