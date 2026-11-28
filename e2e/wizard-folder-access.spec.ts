import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";

import { expect, test } from "@playwright/test";
import pg from "pg";

import { e2eDatabaseUrl, e2eSetupToken } from "../playwright.config";
import { E2E_PASSWORD, signInAsAdministrator } from "./support/admin-session";
import { extractLink, waitForEmail } from "./support/outbox";
import { writeSamplePdf } from "./support/sample-pdf";

test("folders isolate agreements even when one administrator sends to both folders", async ({
  browser,
  page,
}, testInfo) => {
  await page.goto("/login");

  if (new URL(page.url()).pathname === "/setup") {
    const setup = await page.request.post("/api/setup", {
      data: {
        email: "folder-admin@example.com",
        fullName: "Folder Administrator",
        organizationName: "Folder Access Test",
        password: E2E_PASSWORD,
        setupToken: e2eSetupToken,
        supportAddress: "support@example.com",
      },
    });
    expect(setup.status()).toBe(201);
    await page.goto("/dashboard");
  } else {
    await signInAsAdministrator(page);
  }

  const folderNames = ["Vendor agreements", "Policy acknowledgements"] as const;
  const folderIds: string[] = [];
  for (const name of folderNames) {
    const response = await page.request.post("/api/admin/teams?kind=folder", {
      data: { name },
    });
    expect(response.status()).toBe(200);
    const { teams } = (await response.json()) as {
      teams: Array<{ id: string; name: string }>;
    };
    folderIds.push(teams.find((folder) => folder.name === name)!.id);
  }
  const [firstFolderId, secondFolderId] = folderIds as [string, string];
  await page.reload();

  const database = new pg.Client({ connectionString: e2eDatabaseUrl });
  await database.connect();
  const member = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": "198.51.100.83" },
  });

  try {
    const memberPage = await member.newPage();
    const email = `folder-${randomUUID().slice(0, 8)}@example.com`;
    await memberPage.goto("/signup");
    await memberPage.getByLabel("Full name").fill("Folder Member");
    await memberPage.getByLabel("Email").fill(email);
    await memberPage.getByLabel("Password").fill(E2E_PASSWORD);
    await memberPage.getByRole("button", { name: "Sign up" }).click();
    await expect(
      memberPage.getByText("Check your email to verify your sender account."),
    ).toBeVisible();
    const verification = await waitForEmail({
      template: "email_verification",
      to: email,
    });
    await memberPage.goto(
      extractLink(verification.text, "/api/auth/verify-email"),
    );

    const access = await page.request.post(
      `/api/admin/teams/${firstFolderId}/members?kind=folder`,
      { data: { email } },
    );
    expect(access.status()).toBe(200);
    const { teams } = (await access.json()) as {
      teams: Array<{
        id: string;
        members: Array<{ email: string; id: string }>;
      }>;
    };
    const memberId = teams
      .find((folder) => folder.id === firstFolderId)
      ?.members.find((account) => account.email === email)?.id;
    expect(memberId).toBeTruthy();

    await memberPage.getByLabel("Email").fill(email);
    await memberPage.getByLabel("Password").fill(E2E_PASSWORD);
    await memberPage.getByRole("button", { name: "Log in" }).click();
    await expect(memberPage).toHaveURL(/\/dashboard/);

    const file = await writeSamplePdf(testInfo.outputPath("agreement.pdf"));
    const suffix = randomUUID().slice(0, 8);
    const clientTitle = `Vendor agreement ${suffix}`;
    const creatorTitle = `Policy acknowledgement ${suffix}`;

    async function uploadFromFolder(folderName: string, title: string) {
      await page
        .getByRole("navigation", { name: "Document views and folders" })
        .getByRole("link", { name: folderName, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: folderName }),
      ).toBeVisible();
      await page
        .getByRole("main")
        .getByRole("link", { name: "New envelope" })
        .first()
        .click();
      await expect(page).toHaveURL(/\/envelopes\/new\?folder=/);
      await page.getByLabel("Envelope title").fill(title);
      await page.getByLabel("Upload PDF").setInputFiles(file);
      await page.getByRole("button", { name: "Next ->" }).click();
      await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);
      const id = new URL(page.url()).pathname.split("/")[2];
      expect(id).toBeTruthy();
      // Mark the fixture sent, since other members cannot see drafts.
      await database.query(
        "UPDATE envelopes SET status = 'sent', sent_at = $2 WHERE id = $1",
        [id, Math.floor(Date.now() / 1000)],
      );
      await page.goto("/dashboard");
      return id;
    }

    const clientId = await uploadFromFolder(folderNames[0], clientTitle);
    const creatorId = await uploadFromFolder(folderNames[1], creatorTitle);

    const nav = memberPage.getByRole("navigation", {
      name: "Document views and folders",
    });
    await nav.getByRole("link", { name: folderNames[0], exact: true }).click();
    await expect(
      memberPage.getByText(clientTitle, { exact: true }),
    ).toBeVisible();
    await expect(nav.getByRole("link", { name: folderNames[1] })).toHaveCount(
      0,
    );
    await expect(
      memberPage.getByText(creatorTitle, { exact: true }),
    ).toHaveCount(0);
    await memberPage.goto(`/dashboard?folder=${secondFolderId}`);
    await expect(
      memberPage.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    await memberPage.goto(`/envelopes/${creatorId}`);
    await expect(
      memberPage.getByRole("heading", { name: "This envelope is unavailable" }),
    ).toBeVisible();
    expect(
      (
        await memberPage.request.get(`/api/envelopes/${clientId}/document`)
      ).status(),
    ).toBe(200);
    expect(
      (
        await memberPage.request.get(`/api/envelopes/${creatorId}/document`)
      ).status(),
    ).toBe(404);

    await page.goto(`/dashboard?folder=${firstFolderId}`);
    await expect(
      page.getByRole("heading", { name: clientTitle }),
    ).toBeVisible();
    await testInfo.attach("Protected folders dashboard", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await page.goto(`/envelopes/${creatorId}`);
    await page.getByRole("button", { name: "Move to folder" }).click();
    const moveDialog = page.getByRole("dialog", { name: "Move to folder" });
    await moveDialog.getByLabel("Folder").selectOption(firstFolderId);
    await moveDialog.getByRole("button", { name: "Move to folder" }).click();
    await expect(
      page.getByRole("link", { name: `← ${folderNames[0]}` }),
    ).toBeVisible();
    expect(
      (
        await memberPage.request.get(`/api/envelopes/${creatorId}/document`)
      ).status(),
    ).toBe(200);

    const rejected = await memberPage.request.post("/api/envelopes", {
      multipart: {
        file: createReadStream(file),
        folderId: secondFolderId,
        title: "Forged destination",
      },
    });
    expect(rejected.status()).toBe(404);

    const ownDraft = await memberPage.request.post("/api/envelopes", {
      multipart: {
        file: createReadStream(file),
        folderId: firstFolderId,
        title: `Member draft ${suffix}`,
      },
    });
    expect(ownDraft.status()).toBe(201);
    const { envelopeId } = (await ownDraft.json()) as { envelopeId: string };

    expect(
      (
        await memberPage.request.get(`/api/envelopes/${envelopeId}/document`)
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.delete(
          `/api/admin/teams/${firstFolderId}/members/${memberId}?kind=folder`,
        )
      ).status(),
    ).toBe(200);

    const envelopeApi = `/api/envelopes/${envelopeId}`;
    for (const path of [
      "/document",
      "/audit",
      "/download?type=signed",
      "/thumbnail",
    ]) {
      expect((await memberPage.request.get(envelopeApi + path)).status()).toBe(
        404,
      );
    }
    expect((await memberPage.request.delete(envelopeApi)).status()).toBe(404);
    await memberPage.goto(`/envelopes/${envelopeId}/signers`);
    await expect(
      memberPage.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
  } finally {
    await member.close();
    await database.end();
  }
});
