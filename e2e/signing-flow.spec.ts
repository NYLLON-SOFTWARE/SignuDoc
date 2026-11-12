import { expect, test, type Page } from "@playwright/test";

import { extractLink, extractLinks, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

const PASSWORD = "correct horse battery staple 42";
const ENVELOPE_TITLE = "E2E sample agreement";

function watchForContentSecurityPolicyViolations(page: Page, sink: string[]) {
  page.on("console", (message) => {
    const text = message.text();

    if (/content security policy/i.test(text)) {
      sink.push(text);
    }
  });
}

async function expectPdfResponse(response: {
  body(): Promise<Buffer>;
  headers(): Record<string, string>;
  status(): number;
}) {
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  expect(response.headers()["content-disposition"]).toContain("attachment");
  expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");
}

test("a sender can send a PDF and a recipient can sign it", async ({
  browser,
  page,
}, testInfo) => {
  const runId = String(Date.now());
  const senderEmail = `sender+${runId}@example.com`;
  const signerEmail = `signer+${runId}@example.com`;
  const cspViolations: string[] = [];
  let envelopeId = "";

  watchForContentSecurityPolicyViolations(page, cspViolations);

  await test.step("sign up and verify the email address", async () => {
    await page.goto("/signup");
    await page.getByLabel("Full name").fill("Sam Sender");
    await page.getByLabel("Email").fill(senderEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(
      page.getByText("Check your email to verify your sender account."),
    ).toBeVisible();

    const verificationEmail = await waitForEmail({
      template: "email_verification",
      to: senderEmail,
    });

    await page.goto(
      extractLink(verificationEmail.text, "/api/auth/verify-email"),
    );
    await expect(page).toHaveURL(/\/login/);
  });

  await test.step("log in", async () => {
    await page.getByLabel("Email").fill(senderEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", { name: "No documents yet" }),
    ).toBeVisible();
  });

  await test.step("upload a PDF", async () => {
    const pdfPath = await writeSamplePdf(testInfo.outputPath("sample.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill(ENVELOPE_TITLE);
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await expect(page.getByText("sample.pdf")).toBeVisible();
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    envelopeId = /\/envelopes\/([^/]+)\/signers$/.exec(page.url())?.[1] ?? "";
    expect(envelopeId).not.toBe("");
  });

  await test.step("add a signer", async () => {
    await page.getByLabel("Signer 1 name").fill("Riley Recipient");
    await page.getByLabel("Signer 1 email").fill(signerEmail);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);
  });

  await test.step("place a signature field on the rendered page", async () => {
    await expect(
      page.getByRole("img", { name: "Rendered PDF page 1" }),
    ).toBeVisible();
    await page.getByRole("button", { exact: true, name: "Signature" }).click();

    const placementTarget = page.getByLabel("Place Signature on page 1");
    const box = await placementTarget.boundingBox();

    expect(box).not.toBeNull();
    await placementTarget.click({
      position: { x: box!.width * 0.3, y: box!.height * 0.7 },
    });
    await expect(
      page.getByRole("button", { name: "Riley Recipient · Sign" }),
    ).toBeVisible();
    await expect(page.getByText("Signature ready")).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);
  });

  await test.step("review and send", async () => {
    await expect(
      page.getByRole("heading", { name: ENVELOPE_TITLE }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();
  });

  const invitation = await waitForEmail({
    template: "signing_invitation",
    to: signerEmail,
  });
  const signingLink = extractLink(invitation.text, "/sign/");

  await test.step("the recipient signs without an account", async () => {
    const recipientContext = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const recipientPage = await recipientContext.newPage();

    watchForContentSecurityPolicyViolations(recipientPage, cspViolations);

    await recipientPage.goto(signingLink);
    await expect(
      recipientPage.getByRole("img", { name: "Rendered PDF page 1" }),
    ).toBeVisible();
    await expect(recipientPage.getByText("1 required remaining")).toBeVisible();
    await recipientPage
      .getByRole("button", { exact: true, name: "Signature" })
      .click();
    await recipientPage
      .getByRole("dialog", { name: "Add your signature" })
      .getByRole("button", { name: "Apply signature" })
      .click();
    await recipientPage.getByRole("button", { name: "Finish" }).click();
    await recipientPage
      .getByRole("dialog", { name: "Finish signing?" })
      .getByRole("button", { name: "Finish signing" })
      .click();
    await expect(recipientPage).toHaveURL(/\/sign\/[^/]+\/done/);

    const completionEmail = await waitForEmail({
      template: "completion_notification",
      to: signerEmail,
    });
    const downloadLinks = extractLinks(completionEmail.text).filter((link) =>
      new URL(link).pathname.startsWith("/api/download/"),
    );

    expect(downloadLinks.length).toBeGreaterThanOrEqual(1);

    for (const downloadLink of downloadLinks) {
      await expectPdfResponse(await recipientContext.request.get(downloadLink));
    }

    await recipientContext.close();
  });

  await test.step("the sender sees it completed and can download", async () => {
    await waitForEmail({
      template: "completion_notification",
      to: senderEmail,
    });
    await page.goto(`/envelopes/${envelopeId}`);
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download signed PDF" }),
    ).toBeVisible();

    for (const type of ["signed", "evidence"]) {
      await expectPdfResponse(
        await page.request.get(
          `/api/envelopes/${envelopeId}/download?type=${type}`,
        ),
      );
    }
  });

  expect(cspViolations).toEqual([]);
});
