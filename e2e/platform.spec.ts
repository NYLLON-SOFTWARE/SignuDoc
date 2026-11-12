import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";
import pg from "pg";

import { e2eDatabaseUrl } from "../playwright.config";

// The cleanup route and the sign-in limit, as the running app serves them.
// What sits underneath (the rate limit statement, the job's lock and its
// hourly ration) is tested on its own with `npm run test:db`.

const RETENTION_RATION_KEY = createHash("sha256")
  .update("job:retention")
  .digest("hex");

let database: pg.Pool;

test.beforeAll(() => {
  database = new pg.Pool({ connectionString: e2eDatabaseUrl });
});

test.afterAll(async () => {
  await database.end();
});

test("the cleanup route runs for Vercel's cron call and tells a stranger nothing", async ({
  request,
}) => {
  await database.query("delete from public.rate_limits where key = $1", [
    RETENTION_RATION_KEY,
  ]);
  await database.query(
    "insert into public.rate_limits (key, count, expires_at) values ('e2e-finished-window', 3, 1)",
  );

  // This deployment has no CRON_SECRET, like one made with the Deploy
  // button, so Vercel's call arrives with no proof of who it is.
  const first = await request.get("/api/internal/retention");

  expect(first.status()).toBe(204);
  expect(await first.text()).toBe("");

  // It did the work: the finished window is gone.
  const leftover = await database.query(
    "select 1 from public.rate_limits where key = 'e2e-finished-window'",
  );

  expect(leftover.rowCount).toBe(0);

  // A second call inside the hour looks exactly the same from outside.
  const second = await request.post("/api/internal/retention");

  expect(second.status()).toBe(204);
  expect(await second.text()).toBe("");

  // Both were counted against the hourly ration.
  const ration = await database.query<{ count: number }>(
    "select count from public.rate_limits where key = $1",
    [RETENTION_RATION_KEY],
  );

  expect(ration.rows[0]?.count).toBe(2);
});

test("sign-in attempts are limited, and counted in the database", async ({
  request,
}) => {
  // Its own address, so this does not use up the allowance of the browser
  // in the other test.
  const headers = { "x-forwarded-for": "203.0.113.77" };
  const countRows = async () =>
    (
      await database.query<{ total: number }>(
        "select count(*)::int as total from public.rate_limits",
      )
    ).rows[0]?.total ?? 0;
  const before = await countRows();
  const statuses: number[] = [];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request.post("/api/auth/sign-in/email", {
      data: { email: "nobody@example.com", password: "not-the-password" },
      headers,
    });

    statuses.push(response.status());
  }

  // Three wrong passwords are answered as wrong passwords. The fourth
  // within ten seconds is turned away before it is looked at.
  expect(statuses.slice(0, 3)).not.toContain(429);
  expect(statuses[3]).toBe(429);
  expect(await countRows()).toBeGreaterThan(before);
});
