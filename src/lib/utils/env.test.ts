import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getEnv,
  isLocalDeployment,
  resolveAppUrl,
  resolveAuthSecret,
  resolveAuthUrl,
  resolveDatabaseUrl,
  resolveDeploymentOrigins,
} from "./env.ts";

const NEON_URL =
  "postgres://app:npg_Abc123Def456Ghi7@ep-cool-1.us-east-1.aws.neon.tech/neondb?sslmode=require";

const vercelProduction = {
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_BRANCH_URL: "signudoc-git-main-acme.vercel.app",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "sign.acme.com",
  VERCEL_URL: "signudoc-abc123-acme.vercel.app",
};

test("a fresh Vercel install resolves everything from what Vercel provides", () => {
  const env = getEnv({ ...vercelProduction, DATABASE_URL: NEON_URL });

  assert.equal(env.appUrl, "https://sign.acme.com");
  assert.equal(env.auth.betterAuthUrl, "https://sign.acme.com");
  assert.match(env.auth.betterAuthSecret ?? "", /^[0-9a-f]{64}$/);
  assert.match(env.databaseUrl ?? "", /sslmode=verify-full/);
});

test("a preview deployment uses its own branch URL", () => {
  const env = { ...vercelProduction, VERCEL_ENV: "preview" };

  assert.equal(resolveAppUrl(env), "https://signudoc-git-main-acme.vercel.app");
  assert.deepEqual(resolveDeploymentOrigins(env), [
    "https://signudoc-abc123-acme.vercel.app",
    "https://signudoc-git-main-acme.vercel.app",
    "https://sign.acme.com",
  ]);
});

test("explicit settings win over the Vercel defaults", () => {
  const env = {
    ...vercelProduction,
    APP_URL: "https://docs.example.org",
    BETTER_AUTH_SECRET: "x".repeat(40),
    BETTER_AUTH_URL: "https://auth.example.org",
    DATABASE_URL: NEON_URL,
  };

  assert.equal(resolveAppUrl(env), "https://docs.example.org");
  assert.equal(resolveAuthUrl(env), "https://auth.example.org");
  assert.equal(resolveAuthSecret(env), "x".repeat(40));
});

test("placeholders from .env.example count as not set", () => {
  const env = {
    APP_URL: "replace-with-app-url",
    BETTER_AUTH_SECRET: "replace-with-better-auth-secret",
    DATABASE_URL: "replace-with-database-url",
  };

  assert.equal(resolveAppUrl(env), undefined);
  assert.equal(resolveAuthSecret(env), undefined);
  assert.equal(resolveDatabaseUrl(env), undefined);
});

test("the derived secret is stable and follows the database password", () => {
  const first = resolveAuthSecret({ DATABASE_URL: NEON_URL });
  const again = resolveAuthSecret({ DATABASE_URL: NEON_URL });
  const otherPassword = resolveAuthSecret({
    DATABASE_URL: NEON_URL.replace(
      "npg_Abc123Def456Ghi7",
      "npg_Zyx987Wvu654Tsr3",
    ),
  });
  const samePasswordOtherHost = resolveAuthSecret({
    POSTGRES_URL: NEON_URL.replace("ep-cool-1", "ep-cool-1-pooler"),
  });

  assert.equal(first, again);
  assert.notEqual(first, otherPassword);
  assert.equal(first, samePasswordOtherHost);
});

test("a weak database password is not used to derive a production secret", () => {
  const weak = "postgres://signudoc:signudoc@db.internal:5432/signudoc";

  assert.equal(
    resolveAuthSecret({ DATABASE_URL: weak, NODE_ENV: "production" }),
    undefined,
  );
  assert.match(
    resolveAuthSecret({ DATABASE_URL: weak, NODE_ENV: "development" }) ?? "",
    /^[0-9a-f]{64}$/,
  );
});

test("production rejects a short secret and a plain HTTP public URL", () => {
  assert.throws(
    () =>
      resolveAuthSecret({
        BETTER_AUTH_SECRET: "short",
        NODE_ENV: "production",
      }),
    /at least 32 characters/,
  );
  assert.throws(
    () =>
      resolveAppUrl({
        APP_URL: "http://docs.example.org",
        NODE_ENV: "production",
      }),
    /must use HTTPS/,
  );
});

test("a production build may run on localhost, but not on Vercel", () => {
  const local = { APP_URL: "http://localhost:3000", NODE_ENV: "production" };

  assert.equal(resolveAppUrl(local), "http://localhost:3000");
  assert.equal(isLocalDeployment(local), true);
  assert.equal(
    isLocalDeployment({ ...local, APP_URL: "https://docs.example.org" }),
    false,
  );
  assert.throws(
    () => resolveAppUrl({ ...local, VERCEL: "1" }),
    /must not use localhost on Vercel/,
  );
});

test("Supabase's POSTGRES_URL is used when DATABASE_URL is not set", () => {
  const supabase =
    "postgres://postgres.ref:Sup3rSecretPassw0rd@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x";
  const resolved = resolveDatabaseUrl({ POSTGRES_URL: supabase });

  assert.match(resolved ?? "", /uselibpqcompat=true/);
  assert.match(resolved ?? "", /sslmode=require/);
  assert.equal(
    resolveDatabaseUrl({ DATABASE_URL: NEON_URL, POSTGRES_URL: supabase }),
    NEON_URL.replace("sslmode=require", "sslmode=verify-full"),
  );
});
