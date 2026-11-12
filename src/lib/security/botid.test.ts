import assert from "node:assert/strict";
import { test } from "node:test";

import { BOT_PROTECTED_ROUTES, isBotProtectedRoute } from "./botid-routes.ts";
import { BOT_REJECTION_MESSAGE, rejectBots } from "./botid.ts";

function post(path: string) {
  return new Request(`https://sign.example.com${path}`, { method: "POST" });
}

const human = () => Promise.resolve({ isBot: false });
const bot = () => Promise.resolve({ isBot: true });

test("the doors a script would knock on are the protected ones", () => {
  assert.deepEqual(
    BOT_PROTECTED_ROUTES.map((route) => `${route.method} ${route.path}`),
    [
      "POST /api/auth/sign-up/email",
      "POST /api/auth/sign-in/email",
      "POST /api/auth/request-password-reset",
      "POST /api/auth/send-verification-email",
      "POST /api/contact",
      "POST /api/setup",
    ],
  );
  assert.equal(isBotProtectedRoute("post", "/api/auth/sign-in/email/"), true);
  assert.equal(isBotProtectedRoute("GET", "/api/auth/sign-in/email"), false);
  assert.equal(isBotProtectedRoute("POST", "/api/auth/sign-out"), false);
  assert.equal(isBotProtectedRoute("POST", "/api/auth/get-session"), false);
});

test("turned off, nothing is checked", async () => {
  let checks = 0;
  const check = () => {
    checks += 1;

    return bot();
  };

  assert.equal(
    await rejectBots(post("/api/auth/sign-in/email"), {
      check,
      enabled: false,
    }),
    null,
  );
  assert.equal(checks, 0);
  // And it is off unless the build turned it on.
  assert.equal(
    await rejectBots(post("/api/auth/sign-in/email"), { check }),
    null,
  );
  assert.equal(checks, 0);
});

test("turned on, a person is let through and a bot gets a 403 the forms can show", async (t) => {
  t.mock.method(console, "warn", () => undefined);

  assert.equal(
    await rejectBots(post("/api/auth/sign-up/email"), {
      check: human,
      enabled: true,
    }),
    null,
  );

  const response = await rejectBots(post("/api/auth/sign-up/email"), {
    check: bot,
    enabled: true,
  });

  assert.equal(response?.status, 403);
  assert.deepEqual(await response?.json(), {
    code: "BOT_DETECTED",
    error: BOT_REJECTION_MESSAGE,
    message: BOT_REJECTION_MESSAGE,
  });
});

test("requests outside the list are not checked even when it is on", async () => {
  let checks = 0;
  const check = () => {
    checks += 1;

    return bot();
  };

  assert.equal(
    await rejectBots(post("/api/auth/sign-out"), { check, enabled: true }),
    null,
  );
  assert.equal(
    await rejectBots(
      new Request("https://sign.example.com/api/auth/get-session"),
      { check, enabled: true },
    ),
    null,
  );
  assert.equal(checks, 0);
});

test("a check that fails or never answers lets the request in rather than locking everyone out", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined);

  assert.equal(
    await rejectBots(post("/api/auth/sign-in/email"), {
      check: () =>
        Promise.reject(
          new Error("The 'x-vercel-oidc-token' header is missing"),
        ),
      enabled: true,
    }),
    null,
  );
  assert.equal(
    await rejectBots(post("/api/auth/sign-in/email"), {
      check: () => new Promise<{ isBot: boolean }>(() => undefined),
      enabled: true,
      timeoutMs: 20,
    }),
    null,
  );
  // Both are logged, so a broken check does not go unnoticed.
  assert.equal(logged.mock.callCount(), 2);
});
