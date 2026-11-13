import assert from "node:assert/strict";
import { test } from "node:test";

import {
  identifyRetentionCaller,
  isCronLockedOutByOlderSecret,
} from "./retention-job.ts";

// Running the job itself, with its lock and its hourly ration, is checked
// against a real Postgres in retention-job.dbtest.ts.

test("with no secret configured, anyone may ask and nobody is trusted", () => {
  assert.equal(identifyRetentionCaller(null, {}), "anonymous");
  assert.equal(identifyRetentionCaller("Bearer guess", {}), "anonymous");
});

test("with CRON_SECRET set, only a caller that presents it gets in", () => {
  const env = { CRON_SECRET: "cron-secret-value" };

  assert.equal(
    identifyRetentionCaller("Bearer cron-secret-value", env),
    "authorized",
  );
  assert.equal(identifyRetentionCaller(null, env), "denied");
  assert.equal(identifyRetentionCaller("Bearer wrong", env), "denied");
  assert.equal(identifyRetentionCaller("cron-secret-value", env), "denied");
  assert.equal(identifyRetentionCaller("Bearer ", env), "denied");
});

test("RETENTION_JOB_SECRET closes the route the same way, as it always did", () => {
  const env = { RETENTION_JOB_SECRET: "older-secret-value" };

  assert.equal(
    identifyRetentionCaller("Bearer older-secret-value", env),
    "authorized",
  );
  assert.equal(identifyRetentionCaller(null, env), "denied");
  assert.equal(identifyRetentionCaller("Bearer wrong", env), "denied");
});

test("Vercel's cron being refused for want of CRON_SECRET is recognized", () => {
  const olderOnly = { RETENTION_JOB_SECRET: "older-secret-value" };

  assert.equal(
    isCronLockedOutByOlderSecret("vercel-cron/1.0", olderOnly),
    true,
  );
  assert.equal(isCronLockedOutByOlderSecret("curl/8.0", olderOnly), false);
  assert.equal(isCronLockedOutByOlderSecret(null, olderOnly), false);
  assert.equal(
    isCronLockedOutByOlderSecret("vercel-cron/1.0", {
      ...olderOnly,
      CRON_SECRET: "cron-secret-value",
    }),
    false,
  );
  assert.equal(isCronLockedOutByOlderSecret("vercel-cron/1.0", {}), false);
});

test("with both set, either secret works", () => {
  const env = {
    CRON_SECRET: "cron-secret-value",
    RETENTION_JOB_SECRET: "older-secret-value",
  };

  assert.equal(
    identifyRetentionCaller("Bearer cron-secret-value", env),
    "authorized",
  );
  assert.equal(
    identifyRetentionCaller("Bearer older-secret-value", env),
    "authorized",
  );
  assert.equal(identifyRetentionCaller("Bearer wrong", env), "denied");
});
