import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

import {
  e2eDatabaseUrl,
  e2eOutboxDir,
  e2eSetupToken,
} from "../playwright.config";
import { extractLink, extractLinks, waitForEmail } from "./support/outbox";
import { totpCode } from "./support/totp";
import { startEmbedParent } from "./support/embed-parent";
import { writeLargePdf, writeSamplePdf } from "./support/sample-pdf";
import { startSignInWindowAfresh } from "./support/sign-in-limit";
import {
  hasValidSignature,
  startWebhookReceiver,
} from "./support/webhook-receiver";

const PASSWORD = "correct horse battery staple 42";
// The ampersand is on purpose: the name goes into HTML emails and page titles.
const ORGANIZATION_NAME = "Harbour & Finch Legal";
// The accent and the em dash are on purpose: download file names are built
// from the title, and a header value cannot carry the em dash as it is.
const ENVELOPE_TITLE = "Façade works agreement — phase 1";
// Dark enough to carry white text, so it is used exactly as entered.
const BRAND_COLOR = "#0b7a53";
// A one-pixel PNG: the smallest thing that is honestly an image.
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function readAccentColor(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim(),
  );
}

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

test("a new install is set up, a sender sends a PDF and a recipient signs it", async ({
  baseURL,
  browser,
  page,
}, testInfo) => {
  const runId = String(Date.now());
  const adminEmail = `admin+${runId}@example.com`;
  // Not the administrator's own address, so the two cannot be mixed up.
  const supportEmail = `help+${runId}@example.com`;
  const senderEmail = `sender+${runId}@example.com`;
  const outsiderEmail = `outsider+${runId}@elsewhere.example`;
  const signerEmail = `signer+${runId}@example.com`;
  const copyEmail = `copy+${runId}@example.com`;
  const secondSignerEmail = `second+${runId}@example.com`;
  const cspViolations: string[] = [];
  let envelopeId = "";

  watchForContentSecurityPolicyViolations(page, cspViolations);

  await test.step("the first visitor sets the site up", async () => {
    const adminContext = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const adminPage = await adminContext.newPage();

    watchForContentSecurityPolicyViolations(adminPage, cspViolations);

    // Until someone has set it up, every front door leads to the setup page
    // and nobody can create an ordinary account.
    for (const frontDoor of ["/", "/login", "/signup"]) {
      await adminPage.goto(frontDoor);
      await expect(adminPage).toHaveURL(/\/setup$/);
    }

    const earlySignup = await adminContext.request.post(
      "/api/auth/sign-up/email",
      {
        data: {
          email: outsiderEmail,
          name: "Olive Outsider",
          password: PASSWORD,
        },
        headers: { origin: new URL(adminPage.url()).origin },
      },
    );

    expect(earlySignup.status()).toBe(403);
    expect(await earlySignup.json()).toMatchObject({ code: "setup_required" });

    await adminPage.getByLabel("Organization name").fill(ORGANIZATION_NAME);
    await adminPage.getByLabel("Your name").fill("Ada Admin");
    await adminPage.getByLabel("Your email").fill(adminEmail);
    await adminPage.getByLabel("Password").fill(PASSWORD);

    // Setup does not finish without an address people can write to for
    // help. Nothing stands in for it, the administrator's own included.
    await adminPage.getByLabel("Setup token").fill(e2eSetupToken);
    await adminPage.getByRole("button", { name: "Finish setup" }).click();
    await expect(
      adminPage.getByText(
        "Enter an email address people can write to for help",
      ),
    ).toBeVisible();
    await expect(adminPage).toHaveURL(/\/setup$/);
    await adminPage.getByLabel("Support email").fill(supportEmail);

    // The deployment sets SETUP_TOKEN, so knowing the URL is not enough.
    await adminPage.getByLabel("Setup token").fill("not the token");
    await adminPage.getByRole("button", { name: "Finish setup" }).click();
    await expect(
      adminPage.getByText("This is not the setup token for this site"),
    ).toBeVisible();

    await adminPage.getByLabel("Setup token").fill(e2eSetupToken);
    await adminPage.getByRole("button", { name: "Finish setup" }).click();

    // Setup ends signed in, on the administrator's settings.
    await expect(adminPage).toHaveURL(/\/settings#organization$/);
    await expect(
      adminPage.getByRole("link", { exact: true, name: ORGANIZATION_NAME }),
    ).toBeVisible();
    await expect(adminPage.getByLabel("Organization name")).toHaveValue(
      ORGANIZATION_NAME,
    );
    await expect(adminPage.getByLabel("Support address")).toHaveValue(
      supportEmail,
    );
    // The starting sign-up rule is the administrator's own email domain.
    await expect(adminPage.getByLabel("Email domains")).toHaveValue(
      "example.com",
    );
    await expect(
      adminPage.getByText("Emails are being captured, not sent"),
    ).toBeVisible();

    const testEmailResponse = await adminContext.request.post(
      "/api/admin/email",
      { data: { action: "send_test" } },
    );

    expect(testEmailResponse.status()).toBe(200);

    const testEmail = await waitForEmail({
      template: "test_email",
      to: adminEmail,
    });

    expect(testEmail.subject).toBe(`Test email from ${ORGANIZATION_NAME}`);
    // Replies and questions go to the address given at setup.
    expect(testEmail.replyTo).toBe(supportEmail);
    expect(testEmail.text).toContain(`Questions? Contact ${supportEmail}.`);

    // The organization puts its own logo and color on the site. The logo
    // is saved the moment it is chosen, the color with the form.
    await adminPage.getByLabel("Logo image").setInputFiles({
      buffer: LOGO_PNG,
      mimeType: "image/png",
      name: "logo.png",
    });
    await expect(
      adminPage.getByRole("button", { name: "Replace logo" }),
    ).toBeVisible();
    await adminPage.getByLabel("Brand color").fill(BRAND_COLOR);
    await adminPage
      .getByRole("button", { name: "Save organization settings" })
      .click();
    await expect(
      adminPage.getByText("Organization settings saved."),
    ).toBeVisible();
    await expect.poll(() => readAccentColor(adminPage)).toBe(BRAND_COLOR);

    // Words of the administrator's own in place of the standard disclosure
    // are saved only after they agree to the notice about E-SIGN. Cancel
    // saves nothing, and going back to the standard text needs no notice.
    const disclosureBox = adminPage.getByLabel("Disclosure text");
    const saveOrganization = adminPage.getByRole("button", {
      name: "Save organization settings",
    });
    const notice = adminPage.getByRole("dialog", {
      name: "Before you change what signers agree to",
    });

    await expect(
      adminPage.getByText(
        "We're not lawyers, and nothing here is legal advice",
      ),
    ).toBeVisible();
    await disclosureBox.fill("## Signing online\nWe send this online.");
    await saveOrganization.click();
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("U.S. E-SIGN Act");
    await expect(notice).toContainText("Nothing in SignuDoc");
    await notice.getByRole("button", { name: "Cancel" }).click();
    await expect(notice).toBeHidden();
    await expect(
      adminPage.getByText("Organization settings saved."),
    ).toBeHidden();

    await saveOrganization.click();
    await notice.getByRole("button", { name: "I agree" }).click();
    await expect(
      adminPage.getByText("Organization settings saved."),
    ).toBeVisible();

    await adminPage.reload();
    await expect(disclosureBox).toHaveValue(
      "## Signing online\nWe send this online.",
    );

    await adminPage
      .getByRole("button", { name: "Use the standard text" })
      .click();
    await saveOrganization.click();
    await expect(notice).toBeHidden();
    await expect(
      adminPage.getByText("Organization settings saved."),
    ).toBeVisible();
    await adminPage.reload();
    await expect(disclosureBox).toHaveValue("");

    // Setup can only happen once.
    await adminPage.goto("/setup");
    await expect(adminPage).not.toHaveURL(/\/setup/);

    const secondSetup = await adminContext.request.post("/api/setup", {
      data: {
        email: outsiderEmail,
        fullName: "Olive Outsider",
        organizationName: "Someone Else",
        password: PASSWORD,
        setupToken: e2eSetupToken,
      },
    });

    expect(secondSetup.status()).toBe(409);

    await adminContext.close();
  });

  await test.step("pages a signer can reach carry the organization's name and its own links", async () => {
    // These sit outside the signed-in app. None of them may fall back to the
    // hosted service's name, or link to pages only the hosted service has.
    for (const publicPath of [
      "/signer-privacy",
      "/electronic-signatures",
      "/verify",
      "/download/not-a-real-link",
    ]) {
      await page.goto(publicPath);

      // The link still carries the name, and now shows the logo.
      const brandLink = page.getByRole("link", {
        exact: true,
        name: ORGANIZATION_NAME,
      });

      await expect(brandLink).toBeVisible();
      await expect(brandLink.locator("img")).toHaveAttribute(
        "src",
        /^\/api\/brand\/logo\?v=[0-9a-f]{16}$/,
      );
      expect(await readAccentColor(page)).toBe(BRAND_COLOR);

      const footer = page.getByRole("contentinfo");

      await expect(
        footer.getByRole("link", { exact: true, name: "Privacy" }),
      ).toHaveAttribute("href", "/signer-privacy");

      for (const hostedOnly of ["Terms", "Accessibility", "Contact"]) {
        await expect(
          footer.getByRole("link", { exact: true, name: hostedOnly }),
        ).toHaveCount(0);
      }

      // The product's own link goes to its repository. There is no site
      // run by the project to send anyone to.
      await expect(
        footer.getByRole("link", { name: "Powered by SignuDoc" }),
      ).toHaveAttribute("href", "https://github.com/NYLLON-SOFTWARE/SignuDoc");
    }

    // A signer with a question is sent to the organization's own address.
    await page.goto("/signer-privacy");
    await expect(
      page.getByRole("link", { exact: true, name: supportEmail }),
    ).toHaveAttribute("href", `mailto:${supportEmail}`);
  });

  await test.step("an address outside the organization cannot sign up", async () => {
    await page.goto("/signup");
    await expect(page).toHaveTitle(ORGANIZATION_NAME);
    await page.getByLabel("Full name").fill("Olive Outsider");
    await page.getByLabel("Email").fill(outsiderEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(
      page.getByRole("alert").filter({
        hasText:
          "Accounts can be created with an email address at @example.com.",
      }),
    ).toBeVisible();
  });

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

    // Emails carry the organization's name, not the product's.
    expect(verificationEmail.text).toContain(
      `Sent by ${ORGANIZATION_NAME} using SignuDoc.`,
    );

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

    // An ordinary account gets none of the administrator's controls.
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Organization" }),
    ).toHaveCount(0);
    expect((await page.request.get("/api/admin/email")).status()).toBe(403);
    expect(
      (
        await page.request.put("/api/admin/settings", {
          data: { organizationName: "Taken Over", signupMode: "open" },
        })
      ).status(),
    ).toBe(403);

    // Signed in, the login page has nothing to offer and sends them on.
    await page.goto("/login");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  await test.step("a cookie left from a session that is gone still reaches the login page", async () => {
    // Signed out elsewhere, expired, or from a database since replaced:
    // the browser keeps the cookie either way. Treating it as signed in
    // would send the visitor to the dashboard, which sends them back.
    const staleContext = await browser.newContext();

    await staleContext.addCookies([
      {
        name: "better-auth.session_token",
        url: baseURL ?? "",
        value: "no-such-session.c2lnbmF0dXJl",
      },
    ]);

    const stalePage = await staleContext.newPage();

    for (const authPage of ["/login", "/signup"]) {
      await stalePage.goto(authPage);
      await expect(stalePage).toHaveURL(new RegExp(`${authPage}$`));
    }

    await stalePage.goto("/login");
    await expect(
      stalePage.getByRole("button", { name: "Log in" }),
    ).toBeVisible();
    await staleContext.close();
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
    // Someone who gets the finished document without signing it.
    await page.getByRole("button", { name: "+ Add a copy recipient" }).click();
    await page.getByLabel("Copy recipient 1 name").fill("Casey Copy");
    await page.getByLabel("Copy recipient 1 email").fill(copyEmail);

    // One extra check per signer. Each choice is saved, read back, and
    // replaced by the next one; the recipient later signs with no check,
    // which shows the server dropped the earlier ones.
    const accessCode = page.getByLabel("Signer 1 access code");
    const choice = (label: string) =>
      page.getByLabel(`Signer 1 check: ${label}`);
    const none = choice("No extra check");
    const emailCode = choice(
      "Email them a one-time code when they open the link",
    );
    const ownCode = choice("Ask for an access code you give them yourself");
    const saveAndReopen = async () => {
      await page.getByRole("button", { name: "Next →" }).click();
      await expect(page).toHaveURL(/\/prepare$/);
      await page.goto(`/envelopes/${envelopeId}/signers`);
    };

    await expect(none).toBeChecked();
    await expect(accessCode).toHaveCount(0);

    await ownCode.check();
    await expect(accessCode).toBeVisible();
    // Picking an access code without typing one blocks the next step.
    await expect(
      page.getByText("Type the code you will give them"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Next →" })).toBeDisabled();
    await accessCode.fill("4444");
    await saveAndReopen();
    await expect(ownCode).toBeChecked();
    await expect(page.getByText("(a code is set;")).toBeVisible();

    await emailCode.check();
    await expect(accessCode).toHaveCount(0);
    await saveAndReopen();
    await expect(emailCode).toBeChecked();
    await expect(ownCode).not.toBeChecked();

    await none.check();
    await saveAndReopen();
    await expect(none).toBeChecked();
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

    // One of each field the signer answers by typing a number or choosing.
    const placeField = async (tool: string, x: number, y: number) => {
      await page.getByRole("button", { exact: true, name: tool }).click();
      await page.getByLabel(`Place ${tool} on page 1`).click({
        position: { x: box!.width * x, y: box!.height * y },
      });
    };

    await placeField("Number", 0.25, 0.3);
    await placeField("Dropdown", 0.5, 0.3);

    // Until a dropdown has choices the draft is saved but cannot go on.
    await expect(page.getByRole("button", { name: "Next →" })).toBeDisabled();
    await page
      .getByRole("textbox", { name: "Choices" })
      .fill("Monthly\nYearly");

    // The field editor is on the page twice, for narrow and for wide
    // windows. The one that was not typed in shows what was saved, so
    // typing in it after the window changes width cannot undo the choices.
    await page.setViewportSize({ height: 900, width: 800 });
    await expect(page.getByRole("textbox", { name: "Choices" })).toHaveValue(
      "Monthly\nYearly",
    );
    await page.setViewportSize({ height: 900, width: 1440 });
    await expect(page.getByRole("textbox", { name: "Choices" })).toHaveValue(
      "Monthly\nYearly",
    );

    await placeField("Radio button", 0.25, 0.4);
    await page
      .getByRole("textbox", { name: "What this button means" })
      .fill("Yes");
    await page
      .getByRole("button", { name: "+ Add a button to this group" })
      .click();
    await page
      .getByRole("textbox", { name: "What this button means" })
      .fill("No");
    await page.setViewportSize({ height: 900, width: 800 });
    await expect(
      page.getByRole("textbox", { name: "What this button means" }),
    ).toHaveValue("No");
    await page.setViewportSize({ height: 900, width: 1440 });
    await expect(page.getByRole("button", { name: "Next →" })).toBeEnabled();
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);
  });

  await test.step("review and send", async () => {
    await expect(
      page.getByRole("heading", { name: ENVELOPE_TITLE }),
    ).toBeVisible();
    // The sender decides how long signers get and how often to nudge them.
    await page.getByLabel("Signing deadline").selectOption("7");
    await page.getByLabel("Automatic reminders").selectOption("2");
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();

    await expect(page).toHaveURL(new RegExp(`/envelopes/${envelopeId}$`));
    await expect(page.getByText(/^Expires .+\.$/)).toBeVisible();
    await expect(
      page.getByText("Automatic reminders: every 2 days."),
    ).toBeVisible();
    await expect(page.getByText("Casey Copy")).toBeVisible();
  });

  const invitation = await waitForEmail({
    template: "signing_invitation",
    to: signerEmail,
  });
  const signingLink = extractLink(invitation.text, "/sign/");

  expect(invitation.text).toContain(`through ${ORGANIZATION_NAME}.`);
  const attachOriginal =
    process.env.SIGNUDOC_EMAIL_SIGNER_INVITATION_ATTACHMENT === "1";
  expect(invitation.attachments ?? []).toHaveLength(attachOriginal ? 1 : 0);
  if (process.env.SIGNUDOC_EMAIL_SENDER_SENT_ATTACHMENT === "1") {
    const sentCopy = await waitForEmail({
      template: "sender_sent_copy",
      to: senderEmail,
    });
    expect(sentCopy.attachments).toHaveLength(1);
    if (attachOriginal)
      expect(sentCopy.attachments?.[0]?.sha256).toBe(
        invitation.attachments?.[0]?.sha256,
      );
  }
  const copyActivity = process.env.SIGNUDOC_EMAIL_COPY_ACTIVITY === "1";
  if (copyActivity) {
    const sentNotice = await waitForEmail({
      template: "copy_recipient_sent",
      to: copyEmail,
    });
    expect(sentNotice.text).toContain(ENVELOPE_TITLE);
    expect(sentNotice.text).not.toContain("/sign/");
    expect(sentNotice.attachments ?? []).toHaveLength(0);
  }
  expect(invitation.replyTo).toBe(supportEmail);
  // The logo opens the message, fetched from this site.
  expect(invitation.html).toMatch(
    new RegExp(
      `<img src="${baseURL ?? ""}/api/brand/logo\\?v=[0-9a-f]{16}" alt="Harbour &amp; Finch Legal"`,
    ),
  );

  await test.step("the recipient signs without an account", async () => {
    const recipientContext = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const recipientPage = await recipientContext.newPage();

    watchForContentSecurityPolicyViolations(recipientPage, cspViolations);

    await recipientPage.goto(signingLink);
    if (copyActivity) {
      const opened = await waitForEmail({
        template: "copy_recipient_activity",
        to: copyEmail,
      });
      expect(opened.subject).toContain("opened");
      expect(opened.text).not.toContain("/sign/");
    }

    // Agreement to electronic records comes before anything else.
    const consent = recipientPage.getByRole("dialog", {
      name: "Before you sign",
    });

    await expect(
      consent.getByRole("button", { name: "Agree and continue" }),
    ).toBeDisabled();
    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
    await expect(consent).toBeHidden();
    await expect(
      recipientPage.getByRole("img", { name: "Rendered PDF page 1" }),
    ).toBeVisible();
    expect(await readAccentColor(recipientPage)).toBe(BRAND_COLOR);
    // The signature, the dropdown and the radio group. The number is
    // optional, and the two radio buttons are one question.
    await expect(recipientPage.getByText("3 required remaining")).toBeVisible();
    await recipientPage
      .getByRole("button", { exact: true, name: "Signature" })
      .click();
    await recipientPage
      .getByRole("dialog", { name: "Add your signature" })
      .getByRole("button", { name: "Apply signature" })
      .click();
    await recipientPage.getByLabel("Choose one").selectOption("Yearly");
    await recipientPage.getByRole("radio", { name: "No" }).click();
    await recipientPage.getByRole("radio", { name: "Yes" }).click();
    await expect(
      recipientPage.getByRole("radio", { name: "No" }),
    ).toHaveAttribute("aria-checked", "false");

    // A comma as a decimal mark could be read two ways, so it is not taken.
    await recipientPage.getByLabel("Enter a number").fill("12,5");
    await expect(
      recipientPage.getByRole("button", { name: "Finish" }),
    ).toBeDisabled();
    await recipientPage.getByLabel("Enter a number").fill("1,250.5");
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

    // The signer's copy comes attached, and the Verify page knows it.
    const signedAttachment = completionEmail.attachments?.find(
      (attachment) => !attachment.filename.includes("certificate"),
    );

    expect(completionEmail.attachments?.length).toBe(2);
    expect(signedAttachment).toBeDefined();

    const verification = await recipientContext.request.post("/api/verify", {
      data: { sha256: signedAttachment?.sha256 },
    });

    expect(verification.ok()).toBe(true);
    expect(await verification.json()).toMatchObject({ match: true });

    await recipientContext.close();
  });

  await test.step("the copy recipient gets the finished document", async () => {
    const copyEmailMessage = await waitForEmail({
      template: "completion_notification",
      to: copyEmail,
    });

    expect(copyEmailMessage.attachments?.length).toBe(2);
    expect(
      extractLinks(copyEmailMessage.text).some((link) =>
        new URL(link).pathname.startsWith("/sign/"),
      ),
    ).toBe(false);
  });

  await test.step("the sender sees it completed and can download", async () => {
    const senderEmailMessage = await waitForEmail({
      template: "completion_notification",
      to: senderEmail,
    });
    const attachSenderDocuments =
      process.env.SIGNUDOC_EMAIL_SENDER_COMPLETION_ATTACHMENTS === "1";
    expect(senderEmailMessage.text).toContain(`/envelopes/${envelopeId}`);
    expect(senderEmailMessage.attachments ?? []).toHaveLength(
      attachSenderDocuments ? 1 : 0,
    );
    await page.goto(`/envelopes/${envelopeId}`);
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download signed PDF" }),
    ).toBeVisible();

    for (const type of ["signed", "evidence"]) {
      const download = await page.request.get(
        `/api/envelopes/${envelopeId}/download?type=${type}`,
      );
      await expectPdfResponse(download);
      if (attachSenderDocuments && type === "signed") {
        const signedPdfHash = createHash("sha256")
          .update(await download.body())
          .digest("hex");
        expect(senderEmailMessage.attachments?.[0]?.sha256).toBe(signedPdfHash);
      }
    }
  });

  await test.step("the dashboard shows the first page as a thumbnail", async () => {
    const thumbnailPath = `/api/envelopes/${envelopeId}/thumbnail`;

    await page.goto("/dashboard");

    const thumbnail = page.getByRole("img", {
      name: `First page of ${ENVELOPE_TITLE}`,
    });

    await expect(thumbnail).toBeVisible();
    await expect
      .poll(() =>
        thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);

    // The picture is stored beside the PDF, as a JPEG, and only the account
    // that sent the document can read it. The browser may keep its copy,
    // but has to ask before showing it again.
    await expect
      .poll(async () => (await page.request.get(thumbnailPath)).status())
      .toBe(200);

    const thumbnailHeaders = (await page.request.get(thumbnailPath)).headers();

    expect(thumbnailHeaders["content-type"]).toBe("image/jpeg");
    expect(thumbnailHeaders["cache-control"]).toBe("private, no-cache");
    expect(thumbnailHeaders["etag"]).toBeTruthy();

    // Asking again with the picture's name is answered "still good", with
    // no picture in the answer.
    const revalidation = await page.request.get(thumbnailPath, {
      headers: { "if-none-match": thumbnailHeaders["etag"] },
    });

    expect(revalidation.status()).toBe(304);
    expect((await revalidation.body()).byteLength).toBe(0);
    expect(revalidation.headers()["cache-control"]).toBe("private, no-cache");

    // Signed out, the same question gets no answer at all.
    const anonymousContext = await browser.newContext();

    expect((await anonymousContext.request.get(thumbnailPath)).status()).toBe(
      401,
    );
    expect(
      (
        await anonymousContext.request.get(thumbnailPath, {
          headers: { "if-none-match": thumbnailHeaders["etag"] },
        })
      ).status(),
    ).toBe(401);
    await anonymousContext.close();
  });

  await test.step("the document is saved as a template and used for the next one", async () => {
    await page.goto(`/envelopes/${envelopeId}`);
    await page.getByRole("button", { name: "Save as template" }).click();

    const saveDialog = page.getByRole("dialog", { name: "Save as a template" });

    await saveDialog.getByLabel("Template name").fill("Works agreement");
    await saveDialog
      .getByRole("textbox", { name: /^Signer 1/ })
      .fill("Contractor");
    await saveDialog.getByLabel("Email subject (optional)").fill("Please sign");
    await saveDialog
      .getByLabel("Email message (optional)")
      .fill("Please review the scope of work.");
    await saveDialog.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByText("Saved as the template")).toBeVisible();

    await page.getByRole("link", { name: "View templates" }).click();
    await expect(page).toHaveURL(/\/templates$/);
    await expect(
      page.getByRole("heading", { name: "Works agreement" }),
    ).toBeVisible();
    // The template names a role, not the person who signed the original.
    await expect(page.getByText("1. Contractor")).toBeVisible();
    await expect(page.getByText("Riley Recipient")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Edit invitation for Works agreement" })
      .click();
    const editDialog = page.getByRole("dialog", { name: "Edit invitation" });
    await expect(editDialog.getByLabel("Email subject (optional)")).toHaveValue(
      "Please sign",
    );
    await editDialog
      .getByLabel("Email message (optional)")
      .fill("Please review the updated scope of work.");
    await editDialog.getByRole("button", { name: "Save invitation" }).click();
    await expect(editDialog).toHaveCount(0);

    await page.getByRole("link", { name: "Use template" }).click();
    await expect(page).toHaveURL(/\/templates\/[^/]+\/use$/);
    await page.getByLabel("Envelope title").fill("Works agreement, phase 2");
    await page.getByLabel("Contractor name").fill("Sasha Second");
    await page.getByLabel("Contractor email").fill(secondSignerEmail);
    await page.getByRole("button", { name: "Create draft" }).click();

    // A new draft with the same fields, on the person named this time,
    // one click from being sent.
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/review$/);
    expect(page.url()).not.toContain(envelopeId);
    await expect(
      page.getByRole("heading", { name: "Works agreement, phase 2" }),
    ).toBeVisible();
    await expect(page.getByText("Sasha Second")).toBeVisible();
    await expect(page.getByText("(4 fields)")).toBeVisible();
    await expect(page.getByLabel("Email subject (optional)")).toHaveValue(
      "Please sign",
    );
    await expect(page.getByLabel("Email message (optional)")).toHaveValue(
      "Please review the updated scope of work.",
    );
    await expect(
      page.getByRole("button", { name: "Send envelope" }),
    ).toBeEnabled();
  });

  // An install from before there were administrators has accounts but
  // nobody in charge. One of its users takes charge with the setup token.
  await test.step("an install with no administrator is claimed with the setup token", async () => {
    const database = new pg.Client({ connectionString: e2eDatabaseUrl });

    await database.connect();

    try {
      await database.query(`update public."user" set role = 'user'`);
      await database.query("delete from public.app_settings");
    } finally {
      await database.end();
    }

    const claim = {
      organizationName: "Second Wind Partners",
      supportAddress: `desk+${runId}@example.com`,
    };
    const anonymousContext = await browser.newContext();

    expect(
      (
        await anonymousContext.request.post("/api/setup", {
          data: { ...claim, setupToken: e2eSetupToken },
        })
      ).status(),
    ).toBe(401);
    await anonymousContext.close();

    // Someone signed in to the wrong account is offered a way to switch.
    // The login page sends signed-in visitors to the dashboard, so the
    // link has to end the session before going there.
    const wrongAccountContext = await browser.newContext();
    const wrongAccountPage = await wrongAccountContext.newPage();

    await wrongAccountPage.goto("/login");
    await wrongAccountPage.getByLabel("Email").fill(senderEmail);
    await wrongAccountPage.getByLabel("Password").fill(PASSWORD);
    await wrongAccountPage.getByRole("button", { name: "Log in" }).click();
    await expect(wrongAccountPage).toHaveURL(/\/dashboard$/);
    await wrongAccountPage.goto("/setup");
    // The settings went with the administrator, the support address among
    // them, so whoever takes charge is asked for one.
    await expect(wrongAccountPage.getByLabel("Support email")).toBeVisible();
    await wrongAccountPage
      .getByRole("button", { name: "Log in as someone else" })
      .click();
    await expect(wrongAccountPage).toHaveURL(/\/login$/);
    await expect(
      wrongAccountPage.getByRole("button", { name: "Log in" }),
    ).toBeVisible();
    await wrongAccountContext.close();

    expect(
      (await page.request.post("/api/setup", { data: claim })).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post("/api/setup", {
          data: { ...claim, setupToken: "not the token" },
        })
      ).status(),
    ).toBe(403);

    const claimed = await page.request.post("/api/setup", {
      data: { ...claim, setupToken: e2eSetupToken },
    });

    expect(claimed.status()).toBe(201);

    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Organization" }),
    ).toBeVisible();
    await expect(page.getByLabel("Organization name")).toHaveValue(
      claim.organizationName,
    );
    await expect(page.getByLabel("Support address")).toHaveValue(
      claim.supportAddress,
    );
    // Sign-up stays as it was before anyone was in charge: open.
    await expect(page.getByRole("radio", { name: /^Anyone/ })).toBeChecked();
  });

  expect(cspViolations).toEqual([]);
});

// Runs after the test above, on the install it left behind: one
// administrator, sign-up open to anyone, no retention period.
test("in Part 11 mode a verified account signs, with its password and a stated meaning", async ({
  browser,
  page,
}, testInfo) => {
  const runId = String(Date.now());
  const signerEmail = `part11+${runId}@example.com`;
  const signerName = "Pat Part";
  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  let adminEmail = "";

  await database.connect();

  try {
    const admin = await database.query<{ email: string }>(
      `select email from public."user" where role = 'admin' limit 1`,
    );

    adminEmail = admin.rows[0]?.email ?? "";
  } finally {
    await database.end();
  }

  expect(adminEmail).not.toBe("");

  await test.step("the administrator turns Part 11 mode on", async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Turn on Part 11 mode" }).click();
    await expect(
      page.getByRole("button", { name: "Turn off Part 11 mode" }),
    ).toBeVisible();
    // A retention period would delete regulated records on a timer.
    await expect(page.getByLabel("Days to keep")).toBeDisabled();
    // Part 11 signers need an account, so the sign-up rule covers them too.
    await expect(
      page.getByText("Part 11 mode is on, so this covers signers too."),
    ).toBeVisible();
    await expect(
      page.getByText("People who are sent a document to sign don't need"),
    ).toHaveCount(0);
  });

  await test.step("the signer makes an account and confirms their email", async () => {
    const signerContext = await browser.newContext();
    const signerPage = await signerContext.newPage();

    await signerPage.goto("/signup");
    await signerPage.getByLabel("Full name").fill(signerName);
    await signerPage.getByLabel("Email").fill(signerEmail);
    await signerPage.getByLabel("Password").fill(PASSWORD);
    await signerPage.getByRole("button", { name: "Sign up" }).click();

    const verificationEmail = await waitForEmail({
      template: "email_verification",
      to: signerEmail,
    });

    await signerPage.goto(
      extractLink(verificationEmail.text, "/api/auth/verify-email"),
    );
    await expect(signerPage).toHaveURL(/\/login/);
    await signerContext.close();
  });

  let envelopeId = "";

  await test.step("a draft names the signer and what their signature means", async () => {
    const pdfPath = await writeSamplePdf(testInfo.outputPath("batch.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Batch record 42");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);
    envelopeId = /\/envelopes\/([^/]+)\/signers$/.exec(page.url())?.[1] ?? "";

    await page.getByLabel("Signer 1 name").fill(signerName);
    await page.getByLabel("Signer 1 email").fill(signerEmail);
    // No meaning, no way on.
    await expect(page.getByRole("button", { name: "Next →" })).toBeDisabled();
    await page
      .getByLabel("Signer 1 signature meaning")
      .selectOption("approval");
    await expect(page.getByText("I approve this document.")).toBeVisible();
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
  });

  async function trySend() {
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();
  }

  await test.step("it is not sent until an administrator confirms who the signer is", async () => {
    await trySend();
    await expect(
      page.getByText(
        `An administrator has to confirm ${signerName}'s identity under Settings, People before they can sign.`,
      ),
    ).toBeVisible();

    await page.goto("/settings");
    await page
      .getByRole("button", { name: `Confirm ${signerName}'s identity` })
      .click();
    await page
      .getByLabel("How did you check who this is?")
      .fill("Badge checked in person");
    await page.getByRole("button", { exact: true, name: "Save" }).click();
    await expect(
      page.getByRole("button", {
        name: `Take back ${signerName}'s identity confirmation`,
      }),
    ).toBeVisible();

    await page.goto(`/envelopes/${envelopeId}/review`);
    await trySend();
    await expect(page).toHaveURL(new RegExp(`/envelopes/${envelopeId}$`));
  });

  await test.step("the signer gives their password to open it and again to sign", async () => {
    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: signerEmail,
    });
    expect(invitation.attachments ?? []).toHaveLength(0);
    const signerContext = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const signerPage = await signerContext.newPage();

    await signerPage.goto(extractLink(invitation.text, "/sign/"));
    await expect(
      signerPage.getByRole("heading", { name: "Confirm it's you" }),
    ).toBeVisible();
    await signerPage.getByLabel("Email address").fill(signerEmail);
    await signerPage.getByLabel("Password").fill(PASSWORD);
    await signerPage.getByRole("button", { name: "Continue" }).click();

    const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
    await signerPage
      .getByRole("button", { exact: true, name: "Signature" })
      .click();
    await signerPage
      .getByRole("dialog", { name: "Add your signature" })
      .getByRole("button", { name: "Apply signature" })
      .click();
    await signerPage.getByRole("button", { name: "Finish" }).click();

    const finish = signerPage.getByRole("dialog", { name: "Finish signing?" });
    const finishButton = finish.getByRole("button", { name: "Finish signing" });

    await expect(
      finish.getByText("Approval: I approve this document."),
    ).toBeVisible();
    await expect(finishButton).toBeDisabled();
    await finish
      .getByRole("checkbox", { name: "I confirm the meaning of my signature" })
      .check();
    await finish.getByLabel("Email address").fill(signerEmail);
    await finish.getByLabel("Password").fill("not my password");
    await finishButton.click();
    await expect(finish.getByRole("alert")).toBeVisible();

    await finish.getByLabel("Password").fill(PASSWORD);
    await finishButton.click();
    await expect(signerPage).toHaveURL(/\/sign\/[^/]+\/done/);
    await signerContext.close();
  });

  await test.step("the audit trails record it and export as CSV", async () => {
    await waitForEmail({ template: "completion_notification", to: adminEmail });

    const envelopeCsv = await (
      await page.request.get(`/api/envelopes/${envelopeId}/audit`)
    ).text();

    expect(envelopeCsv).toContain("Part 11 envelope,yes");
    expect(envelopeCsv).toMatch(/Hash chain check,intact/);
    expect(envelopeCsv).toContain("reauthentication_failed");
    expect(envelopeCsv).toMatch(/,signed,/);
    expect(envelopeCsv).toContain("approval");

    const siteAudit = (await (
      await page.request.get("/api/admin/audit")
    ).json()) as { chain: { ok: boolean }; events: { event: string }[] };

    expect(siteAudit.chain.ok).toBe(true);

    const events = siteAudit.events.map((event) => event.event);

    expect(events).toContain("part11_mode_changed");
    expect(events).toContain("identity_verified");
    expect(events).toContain("reauthentication_failed");

    // The signed PDF still downloads, with the manifestation stamped on it.
    const signed = await page.request.get(
      `/api/envelopes/${envelopeId}/download?type=signed`,
    );

    expect(signed.status()).toBe(200);
  });

  await test.step("the mode can be turned off again", async () => {
    expect(
      (
        await page.request.put("/api/admin/part11", {
          data: { enabled: false },
        })
      ).status(),
    ).toBe(200);
    // With the mode off, ordinary signers again need no account.
    await page.goto("/settings");
    await expect(
      page.getByText("People who are sent a document to sign don't need"),
    ).toBeVisible();
  });
});

test("a signer signs with a qualified signature in their own name, through the signing provider", async ({
  browser,
  page,
}, testInfo) => {
  const runId = String(Date.now());
  const signerEmail = `qualified+${runId}@example.com`;
  const signerName = "Quinn Qualified";
  const signatureType = "Qualified electronic signatures through eID Easy";
  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  let adminEmail = "";

  await database.connect();

  try {
    const admin = await database.query<{ email: string }>(
      `select email from public."user" where role = 'admin' limit 1`,
    );

    adminEmail = admin.rows[0]?.email ?? "";
  } finally {
    await database.end();
  }

  expect(adminEmail).not.toBe("");

  let envelopeId = "";

  await test.step("the sender asks for qualified signatures", async () => {
    const pdfPath = await writeSamplePdf(testInfo.outputPath("supply.pdf"));

    await page.goto("/login");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Supply agreement");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);
    envelopeId = /\/envelopes\/([^/]+)\/signers$/.exec(page.url())?.[1] ?? "";

    await page.getByLabel("Signer 1 name").fill(signerName);
    await page.getByLabel("Signer 1 email").fill(signerEmail);
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

    await page.getByLabel("Signature type").selectOption("qualified");
    await expect(page.getByText(/this is not legal advice/)).toBeVisible();
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await expect(
      confirmation.getByText(`Signature type: ${signatureType}.`),
    ).toBeVisible();
    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();
    await expect(page).toHaveURL(new RegExp(`/envelopes/${envelopeId}$`));
    await expect(page.getByText(signatureType)).toBeVisible();
  });

  await test.step("the signer fills in the document, then signs at the provider", async () => {
    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: signerEmail,
    });
    const signerContext = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const signerPage = await signerContext.newPage();
    const providerRequests: string[] = [];

    signerPage.on("request", (request) => {
      if (request.url().includes("/eideasy/")) {
        providerRequests.push(new URL(request.url()).pathname);
      }
    });

    await signerPage.goto(extractLink(invitation.text, "/sign/"));

    const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
    await signerPage
      .getByRole("button", { exact: true, name: "Signature" })
      .click();
    await signerPage
      .getByRole("dialog", { name: "Add your signature" })
      .getByRole("button", { name: "Apply signature" })
      .click();
    await signerPage.getByRole("button", { name: "Finish" }).click();

    const finish = signerPage.getByRole("dialog", { name: "Finish signing?" });

    await expect(
      finish.getByText(/asks for a qualified electronic signature/),
    ).toBeVisible();
    await finish.getByRole("button", { name: "Continue to eID Easy" }).click();
    await expect(signerPage).toHaveURL(/\/sign\/[^/]+\/done/);
    // The browser went to the provider and came back.
    expect(providerRequests).toContain("/eideasy/sign_contract_external");
    await signerContext.close();
  });

  await test.step("the signed PDF carries the signer's own signature", async () => {
    await waitForEmail({ template: "completion_notification", to: adminEmail });

    const signed = await page.request.get(
      `/api/envelopes/${envelopeId}/download?type=signed`,
    );

    await expectPdfResponse(signed);

    const text = (await signed.body()).toString("latin1");

    expect(text).toContain("/SubFilter /ETSI.CAdES.detached");
    // No install seal on top: the signer's signature covers the document.
    expect(text.match(/\/ByteRange/g)?.length).toBe(1);

    await page.goto(`/envelopes/${envelopeId}`);
    await expect(
      page.getByText(
        `Signed by ${signerName} with a qualified electronic signature through eID Easy`,
      ),
    ).toBeVisible();
  });
});

test("a signer who declines is told the decline was recorded, not that the link expired", async ({
  browser,
  page,
}, testInfo) => {
  const runId = String(Date.now());
  const signerEmail = `decliner+${runId}@example.com`;
  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  let adminEmail = "";

  await database.connect();

  try {
    const admin = await database.query<{ email: string }>(
      `select email from public."user" where role = 'admin' limit 1`,
    );

    adminEmail = admin.rows[0]?.email ?? "";
  } finally {
    await database.end();
  }

  expect(adminEmail).not.toBe("");

  let envelopeId = "";

  await test.step("the sender sends a document to one signer", async () => {
    const pdfPath = await writeSamplePdf(testInfo.outputPath("terms.pdf"));

    await page.goto("/login");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Terms to decline");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);
    envelopeId = /\/envelopes\/([^/]+)\/signers$/.exec(page.url())?.[1] ?? "";

    await page.getByLabel("Signer 1 name").fill("Dana Decliner");
    await page.getByLabel("Signer 1 email").fill(signerEmail);
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

  await test.step("the signer declines and sees that it was recorded", async () => {
    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: signerEmail,
    });
    const signerContext = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const signerPage = await signerContext.newPage();

    await signerPage.goto(extractLink(invitation.text, "/sign/"));

    const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
    await signerPage
      .getByRole("button", { exact: true, name: "Decline" })
      .click();

    const decline = signerPage.getByRole("dialog", {
      name: "Decline to sign?",
    });

    await decline
      .getByLabel("Reason (optional)")
      .fill("Terms in section 2 are not what we agreed.");
    await decline.getByRole("button", { name: "Decline to sign" }).click();

    const declined = signerPage.getByRole("heading", {
      name: "You declined to sign",
    });

    await expect(declined).toBeVisible();
    // Focus moves to the outcome, so a screen reader reads it out.
    await expect(declined).toBeFocused();
    await expect(signerPage.getByText("This link has expired")).toHaveCount(0);
    await expect(
      signerPage.getByText(/Request a new signing link/),
    ).toHaveCount(0);
    await signerContext.close();
  });

  await test.step("the sender sees the decline and its reason", async () => {
    await waitForEmail({ template: "decline_notification", to: adminEmail });
    await page.goto(`/envelopes/${envelopeId}`);
    await expect(
      page.getByText(
        "Decline reason: Terms in section 2 are not what we agreed.",
      ),
    ).toBeVisible();
  });

  await test.step("an administrator sees another member's envelope and schedules its deletion", async () => {
    // The envelope becomes a plain member's, as if they had sent it.
    const memberId = `member-${runId}`;
    const memberEmail = `member+${runId}@example.com`;
    const db = new pg.Client({ connectionString: e2eDatabaseUrl });

    await db.connect();

    try {
      await db.query(
        `insert into public."user" (id, name, email, role, "emailVerified") values ($1, 'Mira Member', $2, 'user', true)`,
        [memberId, memberEmail],
      );
      await db.query(`update envelopes set user_id = $1 where id = $2`, [
        memberId,
        envelopeId,
      ]);
    } finally {
      await db.end();
    }

    const senderLabel = `Mira Member (${memberEmail})`;

    // Gone from the administrator's own list, there in everyone's.
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Terms to decline" }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "Everyone's" }).click();
    await expect(page).toHaveURL(/\/dashboard\?view=all$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "All envelopes" }),
    ).toBeVisible();

    const card = page.getByRole("link").filter({ hasText: "Terms to decline" });

    await expect(card).toContainText(senderLabel);

    // Enter searches every envelope, the sender's address included.
    const search = page.getByRole("searchbox", {
      name: "Search by title or email...",
    });

    await search.fill(memberEmail);
    await search.press("Enter");
    await expect(page).toHaveURL(/\/dashboard\?view=all&q=/);
    await expect(card).toBeVisible();

    // Switching views drops the search, in the box too.
    await page.getByRole("link", { name: "Mine" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(search).toHaveValue("");
    await page.getByRole("link", { name: "Everyone's" }).click();
    await expect(page).toHaveURL(/\/dashboard\?view=all$/);
    await expect(search).toHaveValue("");
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/envelopes/${envelopeId}$`));
    await expect(page.getByText(`Sent by ${senderLabel}`)).toBeVisible();
    // What changes the envelope stays with its sender.
    await expect(
      page.getByRole("button", { name: "Copy to new draft" }),
    ).toHaveCount(0);

    // A copy of someone else's certificate is on record.
    const download = page.waitForEvent("download");

    await page.getByRole("button", { name: "Download certificate" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);

    // Nothing goes at once: the deletion is scheduled, and the sender is
    // emailed a link to download it.
    async function scheduleDeletion(reason: string) {
      await page.getByRole("button", { name: "Delete envelope" }).click();

      const confirm = page.getByRole("dialog", {
        name: "Schedule this envelope for deletion?",
      });

      await confirm.getByLabel("Reason (optional)").fill(reason);
      await confirm.getByRole("button", { name: "Schedule deletion" }).click();
      await expect(page.getByText(/Scheduled to be deleted on/)).toBeVisible();
      await expect(page.getByText(`Reason: ${reason}`)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Delete envelope" }),
      ).toHaveCount(0);
    }

    await scheduleDeletion("Changed my mind.");

    const notice = await waitForEmail({
      template: "deletion_notice",
      to: memberEmail,
    });

    expect(notice.subject).toMatch(/^"Terms to decline" will be deleted on /);
    expect(notice.text).toContain(`/envelopes/${envelopeId}`);

    // Any administrator can cancel until then; the sender is told.
    await page.getByRole("button", { name: "Cancel deletion" }).click();
    await page
      .getByRole("dialog", { name: "Cancel this deletion?" })
      .getByRole("button", { name: "Cancel deletion" })
      .click();
    await expect(page.getByText(/Scheduled to be deleted on/)).toHaveCount(0);
    await expect
      .poll(async () => {
        const latest = await waitForEmail({
          template: "deletion_notice",
          to: memberEmail,
        });

        return latest.subject;
      })
      .toBe('"Terms to decline" will not be deleted');

    await scheduleDeletion("Never agreed.");

    // The envelope itself stays until the wait is over.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Terms to decline" }),
    ).toBeVisible();

    // The download, the request and its cancellation stay on record in the
    // install's audit trail, with whose envelope it was.
    const audit = await page.request.get("/api/admin/audit");
    const { events } = (await audit.json()) as {
      events: { event: string; metadata: Record<string, unknown> | null }[];
    };

    expect(
      events.find((event) => event.event === "envelope_file_downloaded")
        ?.metadata,
    ).toMatchObject({
      envelopeId,
      file: "evidence",
      ownerEmail: memberEmail,
    });
    expect(
      events.find((event) => event.event === "envelope_deletion_scheduled")
        ?.metadata,
    ).toMatchObject({
      envelopeId,
      ownerEmail: memberEmail,
      reason: "Never agreed.",
      status: "declined",
    });
    expect(
      events.find((event) => event.event === "envelope_deletion_cancelled")
        ?.metadata,
    ).toMatchObject({ envelopeId, ownerEmail: memberEmail });
  });
});

test("a long Text answer keeps the signing page within the window", async ({
  browser,
  page,
}, testInfo) => {
  const runId = String(Date.now());
  const signerEmail = `long-answer+${runId}@example.com`;
  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  let adminEmail = "";

  await database.connect();

  try {
    const admin = await database.query<{ email: string }>(
      `select email from public."user" where role = 'admin' limit 1`,
    );

    adminEmail = admin.rows[0]?.email ?? "";
  } finally {
    await database.end();
  }

  expect(adminEmail).not.toBe("");

  await test.step("the sender sends a signature and a Text field", async () => {
    const pdfPath = await writeSamplePdf(testInfo.outputPath("form.pdf"));

    await page.goto("/login");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Form with a long answer");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill("Lee Longanswer");
    await page.getByLabel("Signer 1 email").fill(signerEmail);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/prepare$/);

    const placeField = async (tool: string, x: number, y: number) => {
      await page.getByRole("button", { exact: true, name: tool }).click();

      const target = page.getByLabel(`Place ${tool} on page 1`);
      const box = await target.boundingBox();

      expect(box).not.toBeNull();
      await target.click({
        position: { x: box!.width * x, y: box!.height * y },
      });
    };

    await placeField("Signature", 0.3, 0.7);
    await expect(page.getByRole("status")).toHaveText("Saved");
    await placeField("Text", 0.3, 0.4);
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page).toHaveURL(/\/review$/);
    await page.getByRole("button", { name: "Send envelope" }).click();

    const confirmation = page.getByRole("dialog", {
      name: "Send this envelope?",
    });

    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "Send now" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+$/);
  });

  await test.step("typing a long unbroken answer does not widen the page", async () => {
    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: signerEmail,
    });
    // Narrower than the two-column layout, as in the report.
    const signerContext = await browser.newContext({
      viewport: { height: 900, width: 1200 },
    });
    const signerPage = await signerContext.newPage();

    await signerPage.goto(extractLink(invitation.text, "/sign/"));

    const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
    await expect(consent).toBeHidden();

    const pdfPage = signerPage.getByRole("img", {
      name: "Rendered PDF page 1",
    });

    await expect(pdfPage).toBeVisible();

    const answer = signerPage.getByLabel("Enter text", { exact: true });
    const measure = () =>
      signerPage.evaluate(() => document.documentElement.scrollWidth);

    await answer.fill("Short");
    await expect(signerPage.getByText("Short", { exact: true })).toBeVisible();

    const shortWidth = (await pdfPage.boundingBox())?.width ?? 0;

    expect(await measure()).toBeLessThanOrEqual(1200);

    const longAnswer = "W".repeat(230);

    await answer.fill(longAnswer);
    await expect(
      signerPage.getByText(longAnswer, { exact: true }),
    ).toBeAttached();
    expect(await measure()).toBeLessThanOrEqual(1200);
    expect((await pdfPage.boundingBox())?.width).toBeCloseTo(shortWidth, 0);
    // The whole answer is still there to edit.
    await expect(answer).toHaveValue(longAnswer);

    await answer.fill("Short again");
    expect(await measure()).toBeLessThanOrEqual(1200);

    await signerContext.close();
  });
});

test("with local disk storage a PDF just under 20 MB uploads, and a larger request is refused", async ({
  page,
}, testInfo) => {
  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  let adminEmail = "";

  await database.connect();

  try {
    const admin = await database.query<{ email: string }>(
      `select email from public."user" where role = 'admin' limit 1`,
    );

    adminEmail = admin.rows[0]?.email ?? "";
  } finally {
    await database.end();
  }

  expect(adminEmail).not.toBe("");

  await page.goto("/login");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await test.step("a 19 MB PDF, over Next.js's 10 MB default, makes a draft", async () => {
    const pdfPath = await writeLargePdf(
      testInfo.outputPath("large.pdf"),
      19 * 1024 * 1024,
    );

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Large agreement");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);
  });

  await test.step("a request over the limit gets the size message", async () => {
    const response = await page.request.post("/api/envelopes", {
      headers: { origin: new URL(page.url()).origin },
      multipart: {
        file: {
          buffer: Buffer.alloc(22 * 1024 * 1024),
          mimeType: "application/pdf",
          name: "too-large.pdf",
        },
        title: "Too large",
      },
    });

    expect(response.status()).toBe(413);
    expect(await response.json()).toEqual({
      error: "This file exceeds the 20 MB limit.",
    });
  });
});

test("an administrator makes an API key and a webhook, an app sends and downloads an envelope and hears each step, and revoking the key stops it", async ({
  baseURL,
  browser,
  page,
  playwright,
}) => {
  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  let adminEmail = "";

  await database.connect();

  try {
    adminEmail =
      (
        await database.query<{ email: string }>(
          `select email from public."user" where role = 'admin' order by "createdAt" limit 1`,
        )
      ).rows[0]?.email ?? "";
    // This test's sign-in comes between others, so the two-step test after
    // it would be the fourth sign-in in ten seconds.
    await startSignInWindowAfresh(database);
  } finally {
    await database.end();
  }

  expect(adminEmail).not.toBe("");

  // A separate client, with no session cookie: only the key gets it in.
  const api = await playwright.request.newContext({ baseURL });
  let key = "";

  await test.step("the key is made in Settings and shown once", async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/settings");
    await page.getByPlaceholder("For example: Billing app").fill("Billing app");
    await page.getByRole("button", { name: "Create key" }).click();

    key =
      (await page.getByTestId("new-api-key").locator("code").textContent()) ??
      "";
    expect(key).toMatch(/^sdk_[A-Za-z0-9_-]{43}$/);
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("new-api-key")).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "API keys" }).getByText(key.slice(0, 12)),
    ).toBeVisible();
  });

  await test.step("the API answers to the key and to nothing else", async () => {
    const me = await api.get("/api/v1/me", {
      headers: { authorization: `Bearer ${key}` },
    });

    expect(me.status()).toBe(200);
    expect(me.headers()["ratelimit-limit"]).toBe("600");
    expect(await me.json()).toMatchObject({
      key: { name: "Billing app", scope: "write" },
      user: { email: adminEmail },
    });

    const anonymous = await api.get("/api/v1/me");

    expect(anonymous.status()).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  const receiver = await startWebhookReceiver();
  let webhookSecret = "";

  await test.step("a webhook endpoint is added in Settings, and its test event arrives signed", async () => {
    await page
      .getByPlaceholder("https://app.example.com/webhooks/signudoc")
      .fill(receiver.url);
    await page
      .getByPlaceholder("What this endpoint is for")
      .fill("Billing app");
    await page.getByRole("button", { name: "Add endpoint" }).click();

    webhookSecret =
      (await page
        .getByTestId("new-webhook-secret")
        .locator("code")
        .textContent()) ?? "";
    expect(webhookSecret).toMatch(/^whsec_/);
    await page
      .getByTestId("new-webhook-secret")
      .getByRole("button", { name: "Done" })
      .click();

    const endpoints = page.getByRole("list", { name: "Webhook endpoints" });

    await expect(endpoints.getByText(receiver.url)).toBeVisible();
    await endpoints.getByRole("button", { name: "Send test" }).click();
    await expect(page.getByText("The test event was delivered")).toBeVisible();
    expect(receiver.received.map((webhook) => webhook.json.type)).toEqual([
      "webhook.test",
    ]);
    expect(hasValidSignature(receiver.received[0]!, webhookSecret)).toBe(true);
  });

  await test.step("an app creates and sends an envelope, a signer signs, and the app downloads it", async () => {
    const auth = { authorization: `Bearer ${key}` };
    const signerEmail = `api-signer+${String(Date.now())}@example.com`;
    const pdfPath = await writeSamplePdf(
      test.info().outputPath("api-agreement.pdf"),
    );
    const { readFile } = await import("node:fs/promises");
    const data = {
      fields: [
        {
          height: 0.05,
          page: 1,
          signer: "client",
          type: "signature",
          width: 0.3,
          x: 0.1,
          y: 0.7,
        },
      ],
      metadata: { invoice: "INV-1042" },
      send: { expiresInDays: 7, permittedUseConfirmed: true },
      signers: [{ email: signerEmail, name: "Casey Client", ref: "client" }],
      title: "API service agreement",
    };
    const created = await api.post("/api/v1/envelopes", {
      headers: { ...auth, "idempotency-key": "order-1042" },
      multipart: {
        data: JSON.stringify(data),
        file: {
          buffer: await readFile(pdfPath),
          mimeType: "application/pdf",
          name: "agreement.pdf",
        },
      },
    });

    expect(created.status()).toBe(201);

    const envelope = (await created.json()) as {
      id: string;
      metadata: unknown;
      signers: Array<{ ref: string; status: string }>;
      status: string;
    };

    expect(envelope).toMatchObject({
      metadata: { invoice: "INV-1042" },
      signers: [{ ref: "client", status: "notified" }],
      status: "sent",
    });

    // The same request again is the same envelope, not a second one.
    const retried = await api.post("/api/v1/envelopes", {
      headers: { ...auth, "idempotency-key": "order-1042" },
      multipart: {
        data: JSON.stringify(data),
        file: {
          buffer: await readFile(pdfPath),
          mimeType: "application/pdf",
          name: "agreement.pdf",
        },
      },
    });

    expect(retried.headers()["idempotent-replayed"]).toBe("true");
    expect(((await retried.json()) as { id: string }).id).toBe(envelope.id);

    const invitation = await waitForEmail({
      template: "signing_invitation",
      to: signerEmail,
    });
    const signer = await browser.newContext();
    const signerPage = await signer.newPage();

    await signerPage.goto(extractLink(invitation.text, "/sign/"));

    const consent = signerPage.getByRole("dialog", { name: "Before you sign" });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
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
    await signer.close();

    // A cut-off body, or JSON that is not an object, is refused, never
    // read as "no reason given". Sent as bytes: Playwright would turn a
    // string that is not JSON into a JSON string.
    for (const data of [Buffer.from('{"reason":'), Buffer.from('"stop"')]) {
      const refused = await api.post(`/api/v1/envelopes/${envelope.id}/void`, {
        data,
        headers: { ...auth, "content-type": "application/json" },
      });

      expect(refused.status(), await refused.text()).toBe(400);
    }

    const finished = await api.get(`/api/v1/envelopes/${envelope.id}`, {
      headers: auth,
    });

    expect(await finished.json()).toMatchObject({
      files: {
        certificate: `/api/v1/envelopes/${envelope.id}/files/certificate`,
        signed: `/api/v1/envelopes/${envelope.id}/files/signed`,
      },
      signers: [{ status: "signed" }],
      status: "completed",
    });

    for (const file of ["signed", "certificate"]) {
      const download = await api.get(
        `/api/v1/envelopes/${envelope.id}/files/${file}`,
        { headers: auth },
      );

      expect(download.status()).toBe(200);
      expect(download.headers()["content-type"]).toContain("application/pdf");
      expect((await download.body()).subarray(0, 5).toString()).toBe("%PDF-");
    }

    const events = (await (
      await api.get(`/api/v1/envelopes/${envelope.id}/events`, {
        headers: auth,
      })
    ).json()) as { data: Array<{ event: string }> };

    expect(events.data.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "created",
        "sent",
        "viewed",
        "signed",
        "completed",
      ]),
    );

    const list = (await (
      await api.get("/api/v1/envelopes?status=completed&limit=5", {
        headers: auth,
      })
    ).json()) as { data: Array<{ id: string }> };

    expect(list.data.map((item) => item.id)).toContain(envelope.id);

    // Each step reached the app, signed, carrying the envelope.
    await expect
      .poll(() =>
        receiver.received
          .filter((webhook) => webhook.json.type !== "webhook.test")
          .map((webhook) => webhook.json.type)
          .sort(),
      )
      .toEqual([
        "envelope.completed",
        "envelope.sent",
        "signer.signed",
        "signer.viewed",
      ]);

    for (const webhook of receiver.received) {
      expect(hasValidSignature(webhook, webhookSecret)).toBe(true);
    }

    const completedHook = receiver.received.find(
      (webhook) => webhook.json.type === "envelope.completed",
    );

    expect(completedHook?.json.data).toMatchObject({
      envelope: {
        files: { signed: `/api/v1/envelopes/${envelope.id}/files/signed` },
        id: envelope.id,
        metadata: { invoice: "INV-1042" },
        status: "completed",
      },
      owner: { email: adminEmail },
    });

    const deliveries = (await (
      await api.get("/api/v1/webhook-deliveries?type=envelope.completed", {
        headers: auth,
      })
    ).json()) as { data: Array<{ envelopeId: string; status: string }> };

    expect(deliveries.data[0]).toMatchObject({
      envelopeId: envelope.id,
      status: "delivered",
    });

    const openapi = await api.get("/api/v1/openapi.json");

    expect(openapi.status()).toBe(200);
    expect(((await openapi.json()) as { openapi: string }).openapi).toBe(
      "3.1.0",
    );
  });

  await test.step("a revoked key is refused at once", async () => {
    await page.getByRole("button", { name: "Revoke Billing app" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(
      page.getByRole("list", { name: "API keys" }).getByText("Revoked"),
    ).toBeVisible();

    const refused = await api.get("/api/v1/me", {
      headers: { authorization: `Bearer ${key}` },
    });

    expect(refused.status()).toBe(401);
  });

  await api.dispose();
  await receiver.close();
});

test("an app shows the signing page in its own site, only on a site an administrator allowed, and hears that it was signed", async ({
  baseURL,
  browser,
  page,
  playwright,
}) => {
  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  let adminEmail = "";

  await database.connect();

  try {
    adminEmail =
      (
        await database.query<{ email: string }>(
          `select email from public."user" where role = 'admin' order by "createdAt" limit 1`,
        )
      ).rows[0]?.email ?? "";
    // Like the API key test, this one signs in just before the two-step
    // test: start the sign-in window afresh.
    await startSignInWindowAfresh(database);
  } finally {
    await database.end();
  }

  expect(adminEmail).not.toBe("");

  const api = await playwright.request.newContext({ baseURL });
  const portal = await startEmbedParent();
  const stranger = await startEmbedParent();
  let key = "";

  await test.step("an administrator makes a key and allows the app's site", async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/settings");
    await page.getByPlaceholder("For example: Billing app").fill("Portal");
    await page.getByRole("button", { name: "Create key" }).click();
    key =
      (await page.getByTestId("new-api-key").locator("code").textContent()) ??
      "";
    expect(key).toMatch(/^sdk_/);
    await page.getByRole("button", { name: "Done" }).click();

    await page
      .getByPlaceholder("https://app.example.com", { exact: true })
      .fill(portal.origin);
    await page.getByRole("button", { name: "Allow site" }).click();
    await expect(
      page
        .getByRole("list", { name: "Sites allowed to embed signing" })
        .getByText(portal.origin),
    ).toBeVisible();
  });

  const auth = () => ({ authorization: `Bearer ${key}` });
  const signerEmail = `embedded-signer+${String(Date.now())}@example.com`;
  let envelopeId = "";
  let signerId = "";

  await test.step("the app sends an envelope for embedded signing, and no email goes out", async () => {
    const pdfPath = await writeSamplePdf(
      test.info().outputPath("embedded-agreement.pdf"),
    );
    const { readFile } = await import("node:fs/promises");
    const created = await api.post("/api/v1/envelopes", {
      headers: auth(),
      multipart: {
        data: JSON.stringify({
          fields: [
            {
              height: 0.05,
              page: 1,
              signer: "client",
              type: "signature",
              width: 0.3,
              x: 0.1,
              y: 0.7,
            },
          ],
          send: { delivery: "embedded", permittedUseConfirmed: true },
          signers: [
            { email: signerEmail, name: "Robin Portal", ref: "client" },
          ],
          title: "Portal service agreement",
        }),
        file: {
          buffer: await readFile(pdfPath),
          mimeType: "application/pdf",
          name: "agreement.pdf",
        },
      },
    });

    expect(created.status()).toBe(201);

    const envelope = (await created.json()) as {
      delivery: string;
      id: string;
      signers: Array<{ id: string; status: string }>;
      status: string;
    };

    expect(envelope).toMatchObject({
      delivery: "embedded",
      signers: [{ status: "notified" }],
      status: "sent",
    });
    envelopeId = envelope.id;
    signerId = envelope.signers[0]!.id;
  });

  let link = "";

  await test.step("a signing link is made only for an allowed site", async () => {
    const path = `/api/v1/envelopes/${envelopeId}/signers/${signerId}/embed-link`;
    const refused = await api.post(path, {
      data: { origin: stranger.origin },
      headers: auth(),
    });

    expect(refused.status()).toBe(403);

    const made = await api.post(path, {
      data: { origin: portal.origin },
      headers: auth(),
    });

    expect(made.status()).toBe(201);

    const body = (await made.json()) as { object: string; url: string };

    expect(body.object).toBe("embed_link");
    link = body.url;
    expect(new URL(link).searchParams.get("origin")).toBe(portal.origin);
  });

  await test.step("another site cannot frame that link", async () => {
    const strangerPage = await page.context().newPage();
    const refusals: string[] = [];

    strangerPage.on("console", (message) => {
      if (/frame-ancestors/.test(message.text())) {
        refusals.push(message.text());
      }
    });
    await strangerPage.goto(stranger.pageFor(link));
    await expect.poll(() => refusals.length).toBeGreaterThan(0);
    await expect(
      strangerPage
        .frameLocator("#signing")
        .getByRole("dialog", { name: "Before you sign" }),
    ).toHaveCount(0);
    await strangerPage.close();
  });

  await test.step("the signer signs inside the app's page, and the app is told", async () => {
    const context = await browser.newContext();
    const portalPage = await context.newPage();

    await portalPage.goto(portal.pageFor(link));

    const frame = portalPage.frameLocator("#signing");
    const consent = frame.getByRole("dialog", { name: "Before you sign" });

    await consent
      .getByRole("checkbox", {
        name: "I agree to use electronic records and signatures",
      })
      .check();
    await consent.getByRole("button", { name: "Agree and continue" }).click();
    await frame.getByRole("button", { exact: true, name: "Signature" }).click();
    await frame
      .getByRole("dialog", { name: "Add your signature" })
      .getByRole("button", { name: "Apply signature" })
      .click();
    await frame.getByRole("button", { name: "Finish" }).click();
    await frame
      .getByRole("dialog", { name: "Finish signing?" })
      .getByRole("button", { name: "Finish signing" })
      .click();

    await expect
      .poll(() =>
        portalPage.evaluate(() =>
          (
            window as unknown as {
              signudocMessages: Array<{ data: { type?: string } }>;
            }
          ).signudocMessages.map((message) => message.data.type),
        ),
      )
      .toContain("signudoc:signed");

    const messages = await portalPage.evaluate(
      () =>
        (
          window as unknown as {
            signudocMessages: Array<{ data: unknown; origin: string }>;
          }
        ).signudocMessages,
    );

    expect(
      messages.find(
        (message) =>
          (message.data as { type?: string }).type === "signudoc:signed",
      ),
    ).toMatchObject({
      data: { envelopeId, signerId, type: "signudoc:signed" },
      origin: new URL(baseURL!).origin,
    });
    // The frame moves on to the embedded done page, still inside the app.
    await expect
      .poll(() =>
        portalPage
          .frames()
          .some((child) => /\/embed\/sign\/[^/]+\/done/.test(child.url())),
      )
      .toBe(true);
    await context.close();
  });

  await test.step("the envelope is completed, and the signer was never emailed an invitation", async () => {
    await expect
      .poll(async () => {
        const response = await api.get(`/api/v1/envelopes/${envelopeId}`, {
          headers: auth(),
        });

        return ((await response.json()) as { status: string }).status;
      })
      .toBe("completed");

    const { readdir, readFile } = await import("node:fs/promises");
    const invitations: string[] = [];

    for (const file of await readdir(e2eOutboxDir)) {
      const message = JSON.parse(
        await readFile(`${e2eOutboxDir}/${file}`, "utf8"),
      ) as { template?: string; to?: string | string[] };

      if (
        message.template === "signing_invitation" &&
        [message.to].flat().includes(signerEmail)
      ) {
        invitations.push(file);
      }
    }

    expect(invitations).toEqual([]);
  });

  await api.dispose();
  await portal.close();
  await stranger.close();
});

test("two-step sign-in: an administrator sets it up and requires it of everyone", async ({
  browser,
  page,
}) => {
  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  let adminEmail = "";
  let memberEmail = "";

  await database.connect();

  try {
    adminEmail =
      (
        await database.query<{ email: string }>(
          `select email from public."user" where role = 'admin' order by "createdAt" limit 1`,
        )
      ).rows[0]?.email ?? "";
    memberEmail =
      (
        await database.query<{ email: string }>(
          `
            select u.email from public."user" u
            where u.role = 'user' and u."emailVerified"
              and exists (
                select 1 from public.account a
                where a."userId" = u.id and a.password is not null
              )
            order by u."createdAt" limit 1
          `,
        )
      ).rows[0]?.email ?? "";
  } finally {
    await database.end();
  }

  expect(adminEmail).not.toBe("");
  expect(memberEmail).not.toBe("");

  let key = "";
  let backupCode = "";

  await test.step("requiring it is refused until the administrator uses it", async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/settings");
    await page
      .getByRole("button", { name: "Require two-step sign-in" })
      .click();
    await expect(
      page.getByText(/Set up two-step sign-in for your own account first/),
    ).toBeVisible();
  });

  await test.step("the administrator sets up an authenticator app", async () => {
    await page.getByRole("button", { name: "Set up two-step sign-in" }).click();
    await page.getByLabel("Your password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("img", { name: "QR code for your authenticator app" }),
    ).toBeVisible();

    key = (await page.getByTestId("totp-secret").textContent()) ?? "";
    backupCode =
      (await page
        .getByRole("list", { name: "Backup codes" })
        .getByRole("listitem")
        .first()
        .textContent()) ?? "";

    expect(key.replace(/\s/g, "")).toMatch(/^[A-Z2-7]+$/);
    expect(backupCode).not.toBe("");

    await page.getByLabel("6-digit code").fill(totpCode(key));
    await page
      .getByRole("button", { name: "Turn on two-step sign-in" })
      .click();
    await expect(
      page.getByRole("button", { name: "Make new backup codes" }),
    ).toBeVisible();
  });

  await test.step("and requires it of everyone", async () => {
    await page
      .getByRole("button", { name: "Require two-step sign-in" })
      .click();
    await expect(page.getByText("Required for everyone")).toBeVisible();
  });

  await test.step("signing in now asks for the second step; a backup code works", async () => {
    const context = await browser.newContext({
      // Better Auth allows three sign-ins per address in ten seconds. Each
      // browser here gets its own address so the steps do not race it.
      extraHTTPHeaders: { "x-forwarded-for": "198.51.100.21" },
    });
    const adminPage = await context.newPage();

    await adminPage.goto("/login");
    await adminPage.getByLabel("Email").fill(adminEmail);
    await adminPage.getByLabel("Password").fill(PASSWORD);
    await adminPage.getByRole("button", { name: "Log in" }).click();
    await expect(
      adminPage.getByRole("heading", { name: "Enter your code" }),
    ).toBeVisible();
    await adminPage
      .getByRole("button", { name: "Lost your phone? Use a backup code" })
      .click();
    await adminPage.getByLabel("Backup code").fill(backupCode);
    await adminPage.getByRole("button", { name: "Continue" }).click();
    await expect(adminPage).toHaveURL(/\/dashboard$/);
    await context.close();
  });

  await test.step("someone without it is asked to set it up before anything else", async () => {
    const context = await browser.newContext({
      // Better Auth allows three sign-ins per address in ten seconds. Each
      // browser here gets its own address so the steps do not race it.
      extraHTTPHeaders: { "x-forwarded-for": "198.51.100.22" },
    });
    const memberPage = await context.newPage();

    await memberPage.goto("/login");
    await memberPage.getByLabel("Email").fill(memberEmail);
    await memberPage.getByLabel("Password").fill(PASSWORD);
    await memberPage.getByRole("button", { name: "Log in" }).click();
    await expect(memberPage).toHaveURL(/\/two-step-setup$/);
    await expect(
      memberPage.getByRole("heading", { name: "Set up two-step sign-in" }),
    ).toBeVisible();

    // The API refuses too, not only the pages.
    const envelopes = await memberPage.request.post("/api/envelopes", {
      data: {},
    });

    expect(envelopes.status()).toBe(403);
    await memberPage.goto("/dashboard");
    await expect(memberPage).toHaveURL(/\/two-step-setup$/);
    await context.close();
  });

  await test.step("the site audit trail has all of it", async () => {
    const siteAudit = (await (
      await page.request.get("/api/admin/audit")
    ).json()) as {
      chain: { ok: boolean };
      events: { event: string; metadata: Record<string, unknown> | null }[];
    };

    expect(siteAudit.chain.ok).toBe(true);

    const events = siteAudit.events.map((event) => event.event);

    expect(events).toContain("two_factor_enabled");
    expect(events).toContain("two_factor_requirement_changed");
    expect(
      siteAudit.events.some(
        (event) =>
          event.event === "sign_in_succeeded" &&
          event.metadata?.secondStep === "backup_code",
      ),
    ).toBe(true);
  });

  await test.step("session limits are saved and recorded", async () => {
    await page
      .getByLabel("Sign out after no use for")
      .selectOption({ label: "8 hours" });
    await page.getByRole("button", { name: "Save session limits" }).click();
    await expect(page.getByText("Session limits saved.")).toBeVisible();
    // Still signed in: the page's own session is well within the limit.
    await page.reload();
    await expect(page.getByLabel("Sign out after no use for")).toHaveValue(
      "480",
    );
  });

  await test.step("the requirement can be lifted again", async () => {
    await page
      .getByRole("button", { name: "Stop requiring two-step sign-in" })
      .click();
    await expect(page.getByText("Optional", { exact: true })).toBeVisible();
  });
});
