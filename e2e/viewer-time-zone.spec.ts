import { expect, test, type Page } from "@playwright/test";

import { signInAsAdministrator } from "./support/admin-session";
import { writeSamplePdf } from "./support/sample-pdf";

// Runs after signing-flow.spec.ts, which sets up the install and its
// administrator.

// The sender is in Detroit. The server, as on any deployment, is not.
test.use({ timezoneId: "America/Detroit" });

function timelineTimes(page: Page) {
  return page
    .locator("article")
    .filter({
      has: page.getByRole("heading", { exact: true, name: "Timeline" }),
    })
    .locator("time");
}

function deadline(page: Page) {
  return page.getByText(/^Expires .+\.$/).locator("time");
}

test("the envelope page gives its times in the reader's own time zone", async ({
  browser,
  page,
}, testInfo) => {
  await test.step("a sender in Detroit sends an envelope", async () => {
    await signInAsAdministrator(page);

    const pdfPath = await writeSamplePdf(testInfo.outputPath("times.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Read in two time zones");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 name").fill("Zadie Zone");
    await page.getByLabel("Signer 1 email").fill("zadie.zone@example.com");
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
    await expect(page).toHaveURL(/\/envelopes\/[^/]+$/);
  });

  await test.step("the times are Detroit's, and say so", async () => {
    await expect(timelineTimes(page).first()).toHaveText(/ E[DS]T$/);
    await expect(deadline(page)).toHaveText(/ E[DS]T$/);
  });

  await test.step("a reader in Belgrade sees the same moments in Belgrade's time", async () => {
    const otherContext = await browser.newContext({
      storageState: await page.context().storageState(),
      timezoneId: "Europe/Belgrade",
      viewport: { height: 900, width: 1440 },
    });

    try {
      const otherPage = await otherContext.newPage();
      // The page is first drawn in UTC, on the server and in the browser
      // alike, and only then in the reader's zone. Were the two first
      // drawings to differ, React would say so here.
      const problems: string[] = [];

      otherPage.on("pageerror", (error) => problems.push(error.message));
      otherPage.on("console", (message) => {
        if (
          message.type() === "error" &&
          /hydrat|react\.dev\/errors\/4(18|23|25)/i.test(message.text())
        ) {
          problems.push(message.text());
        }
      });

      await otherPage.goto(page.url());
      await expect(timelineTimes(otherPage).first()).toHaveText(/ GMT\+[12]$/);
      await expect(deadline(otherPage)).toHaveText(/ GMT\+[12]$/);

      for (const times of [timelineTimes, deadline]) {
        const here = times(page).first();
        const there = times(otherPage).first();

        // The same moment, written differently.
        await expect(there).toHaveAttribute(
          "datetime",
          (await here.getAttribute("datetime"))!,
        );
        expect(await there.innerText()).not.toBe(await here.innerText());
      }

      expect(problems).toEqual([]);
    } finally {
      await otherContext.close();
    }
  });

  await test.step("as the server sends it, the page gives the times in UTC and says so", async () => {
    const response = await page.request.get(page.url());
    const html = await response.text();
    const times = [...html.matchAll(/<time [^>]*>([^<]*)<\/time>/g)].map(
      (match) => match[1],
    );

    expect(times.length).toBeGreaterThan(0);
    // The deadline and each timeline entry give a time of day.
    expect(times.filter((time) => / [AP]M /.test(time)).length).toBeGreaterThan(
      1,
    );

    for (const time of times) {
      if (/ [AP]M /.test(time)) {
        expect(time).toMatch(/ UTC$/);
      }
    }
  });

  await test.step("when the reader's zone changes, the times follow once the window is back in front", async () => {
    const first = timelineTimes(page).first();
    const moment = await first.getAttribute("datetime");

    // A laptop carried to Kiritimati with the page left open: the browser
    // now reports another zone, and the reader comes back to the window.
    await page.evaluate(() => {
      const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        return {
          ...resolvedOptions.call(this),
          timeZone: "Pacific/Kiritimati",
        };
      };
      window.dispatchEvent(new Event("focus"));
    });

    await expect(first).toHaveText(/ GMT\+14$/);
    await expect(first).toHaveAttribute("datetime", moment!);
    await expect(deadline(page)).toHaveText(/ GMT\+14$/);
  });
});
