import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

import { e2eDatabaseUrl, e2eSetupToken } from "../playwright.config";
import { extractLink, extractLinks, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

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
    }
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

  await test.step("the copy recipient gets the finished document and nothing before it", async () => {
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
    // that sent the document can read it. The browser is told to keep no
    // copy, as it is for the document itself.
    await expect
      .poll(async () => (await page.request.get(thumbnailPath)).status())
      .toBe(200);

    const thumbnailHeaders = (await page.request.get(thumbnailPath)).headers();

    expect(thumbnailHeaders["content-type"]).toBe("image/jpeg");
    expect(thumbnailHeaders["cache-control"]).toBe("private, no-store");

    const anonymousContext = await browser.newContext();

    expect((await anonymousContext.request.get(thumbnailPath)).status()).toBe(
      401,
    );
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

    const claim = { organizationName: "Second Wind Partners" };
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
    // Sign-up stays as it was before anyone was in charge: open.
    await expect(page.getByRole("radio", { name: /^Anyone/ })).toBeChecked();
  });

  expect(cspViolations).toEqual([]);
});
