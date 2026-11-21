import { expect, type Page } from "@playwright/test";

import { e2eDatabaseUrl } from "../../playwright.config";
import { openE2eClient } from "./database";
import { startSendLimitAfresh } from "./send-limit";
import { startSignInWindowAfresh } from "./sign-in-limit";

// The password every account in signing-flow.spec.ts is made with.
export const E2E_PASSWORD = "correct horse battery staple 42";

/**
 * Signs in as the administrator that the first test in signing-flow.spec.ts
 * sets up. The last test there turns on two-step sign-in for them, so it is
 * turned off again first: these tests are about other things, and a
 * password is enough for them.
 */
export async function signInAsAdministrator(page: Page): Promise<string> {
  const database = openE2eClient(e2eDatabaseUrl);
  let adminEmail = "";

  await database.connect();

  try {
    const admin = await database.query<{ email: string; id: string }>(
      `select id, email from public."user" where role = 'admin' order by "createdAt" limit 1`,
    );

    adminEmail = admin.rows[0]?.email ?? "";

    await database.query(
      `update public."user" set "twoFactorEnabled" = false where id = $1`,
      [admin.rows[0]?.id],
    );
    await database.query(`delete from public."twoFactor" where "userId" = $1`, [
      admin.rows[0]?.id,
    ]);
    await database.query(
      `update public.app_settings set require_two_factor = false`,
    );
    // These tests each sign in, one after another, and quick ones can fit
    // four sign-ins into Better Auth's ten-second window.
    await startSignInWindowAfresh(database);
    await startSendLimitAfresh(database, admin.rows[0]?.id ?? "");
  } finally {
    await database.end();
  }

  expect(adminEmail).not.toBe("");

  await page.goto("/login");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  return adminEmail;
}
