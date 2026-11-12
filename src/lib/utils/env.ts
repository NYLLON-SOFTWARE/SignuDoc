import { createHmac } from "node:crypto";

import {
  normalizeDatabaseUrl,
  readDatabasePassword,
  resolveDatabaseUrl as findDatabaseUrl,
} from "../../../db/database-url.mjs";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class MissingEnvError extends Error {
  constructor(variableName: string) {
    super(`Missing required environment variable: ${variableName}`);
    this.name = "MissingEnvError";
  }
}

const PLACEHOLDER_PREFIX = "replace-with-";

// Values copied from .env.example and never filled in count as not set.
function readEnv(env: EnvSource, variableName: string): string | undefined {
  const value = env[variableName];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();

  if (
    trimmedValue.length === 0 ||
    trimmedValue.toLowerCase().startsWith(PLACEHOLDER_PREFIX)
  ) {
    return undefined;
  }

  return trimmedValue;
}

function isProduction(env: EnvSource): boolean {
  return env.NODE_ENV === "production";
}

function isOnVercel(env: EnvSource): boolean {
  return readEnv(env, "VERCEL") === "1";
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

// An explicitly configured public URL has to be HTTPS in production. The one
// exception is a loopback address, so a production build can be run and
// tested on the machine it was built on. That exception does not apply on
// Vercel, where a localhost URL can only be a mistake.
function validatePublicUrl(
  variableName: string,
  value: string,
  env: EnvSource,
): string {
  if (!isProduction(env)) {
    return value;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(
      `${variableName} must be a valid absolute URL in production.`,
    );
  }

  if (isLoopbackHostname(parsedUrl.hostname)) {
    if (isOnVercel(env)) {
      throw new Error(`${variableName} must not use localhost on Vercel.`);
    }

    return value;
  }

  if (parsedUrl.protocol !== "https:") {
    throw new Error(`${variableName} must use HTTPS in production.`);
  }

  return value;
}

// On Vercel the public URL is known without anyone typing it in.
// Production uses the project's production domain (the shortest custom
// domain, or the vercel.app one). A preview uses its own branch URL, so its
// links and auth callbacks stay on the preview.
function resolveVercelUrl(env: EnvSource): string | undefined {
  if (!isOnVercel(env)) {
    return undefined;
  }

  const vercelEnv = readEnv(env, "VERCEL_ENV");
  let host: string | undefined;

  if (vercelEnv === "production") {
    host =
      readEnv(env, "VERCEL_PROJECT_PRODUCTION_URL") ??
      readEnv(env, "VERCEL_URL");
  } else if (vercelEnv === "preview") {
    host = readEnv(env, "VERCEL_BRANCH_URL") ?? readEnv(env, "VERCEL_URL");
  }

  return host ? `https://${host}` : undefined;
}

/** Other URLs this deployment answers on, such as its unique vercel.app URL. */
export function resolveDeploymentOrigins(
  env: EnvSource = process.env,
): string[] {
  if (!isOnVercel(env)) {
    return [];
  }

  return ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"]
    .map((variableName) => readEnv(env, variableName))
    .filter((host) => host !== undefined)
    .map((host) => `https://${host}`);
}

export function resolveAppUrl(
  env: EnvSource = process.env,
): string | undefined {
  const configuredUrl = readEnv(env, "APP_URL");

  if (configuredUrl) {
    return validatePublicUrl("APP_URL", configuredUrl, env);
  }

  return resolveVercelUrl(env);
}

/**
 * True when the app is served from this machine (localhost), which is how a
 * production build is run for local testing and the end-to-end test.
 */
export function isLocalDeployment(env: EnvSource = process.env): boolean {
  const appUrl = resolveAppUrl(env);

  if (!appUrl || isOnVercel(env)) {
    return false;
  }

  try {
    return isLoopbackHostname(new URL(appUrl).hostname);
  } catch {
    return false;
  }
}

export function resolveAuthUrl(
  env: EnvSource = process.env,
): string | undefined {
  const configuredUrl = readEnv(env, "BETTER_AUTH_URL");

  if (configuredUrl) {
    return validatePublicUrl("BETTER_AUTH_URL", configuredUrl, env);
  }

  return resolveAppUrl(env);
}

export function resolveDatabaseUrl(
  env: EnvSource = process.env,
): string | undefined {
  const databaseUrl = findDatabaseUrl(env);

  return databaseUrl ? normalizeDatabaseUrl(databaseUrl.value) : undefined;
}

const MINIMUM_SECRET_LENGTH = 32;
const MINIMUM_PASSWORD_LENGTH_FOR_DERIVED_SECRET = 12;
const DERIVED_SECRET_CONTEXT = "signudoc/better-auth-secret/v1";

let lastDerivedSecret: { password: string; secret: string } | null = null;

// When BETTER_AUTH_SECRET is not set, the auth secret is derived from the
// database password, so a fresh install needs nothing typed in. Anyone who
// holds the database password can already read and write every session, so
// this gives them nothing new. Changing the database password signs
// everyone out; set BETTER_AUTH_SECRET to avoid that.
function deriveAuthSecret(env: EnvSource): string | undefined {
  const databaseUrl = findDatabaseUrl(env);
  const password = databaseUrl
    ? readDatabasePassword(databaseUrl.value)
    : undefined;

  if (!password) {
    return undefined;
  }

  if (
    isProduction(env) &&
    password.length < MINIMUM_PASSWORD_LENGTH_FOR_DERIVED_SECRET
  ) {
    return undefined;
  }

  if (lastDerivedSecret?.password !== password) {
    lastDerivedSecret = {
      password,
      secret: createHmac("sha256", password)
        .update(DERIVED_SECRET_CONTEXT)
        .digest("hex"),
    };
  }

  return lastDerivedSecret.secret;
}

export function resolveAuthSecret(
  env: EnvSource = process.env,
): string | undefined {
  const configuredSecret = readEnv(env, "BETTER_AUTH_SECRET");

  if (!configuredSecret) {
    return deriveAuthSecret(env);
  }

  if (isProduction(env) && configuredSecret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET must be at least ${String(MINIMUM_SECRET_LENGTH)} characters in production.`,
    );
  }

  return configuredSecret;
}

export function hasEnv(
  variableName: string,
  env: EnvSource = process.env,
): boolean {
  return readEnv(env, variableName) !== undefined;
}

/**
 * Hosted mode is for running SignuDoc as a public service under its own
 * name: the landing page, the built-in legal and contact pages, and the
 * SignuDoc name everywhere. Without it an install is neutral and carries
 * the name of the organization that runs it.
 */
export function isHostedMode(env: EnvSource = process.env): boolean {
  const value = readEnv(env, "HOSTED_MODE")?.toLowerCase();

  return value === "1" || value === "true";
}

// Every value is optional here. Code that needs one checks it at the point of
// use (see requireConfigValue), so a missing email setting cannot stop a page
// that never sends email from rendering.
export function getEnv(env: EnvSource = process.env) {
  return {
    databaseUrl: resolveDatabaseUrl(env),
    appUrl: resolveAppUrl(env),
    auth: {
      betterAuthSecret: resolveAuthSecret(env),
      betterAuthUrl: resolveAuthUrl(env),
    },
    email: {
      apiKey: readEnv(env, "RESEND_API_KEY"),
      senderAddress: readEnv(env, "RESEND_FROM_EMAIL"),
      supportAddress: readEnv(env, "SUPPORT_EMAIL"),
    },
    internal: {
      // Vercel sends this as a bearer token on cron calls when it is set.
      cronSecret: readEnv(env, "CRON_SECRET"),
      retentionJobSecret: readEnv(env, "RETENTION_JOB_SECRET"),
    },
    setup: {
      token: readEnv(env, "SETUP_TOKEN"),
    },
  };
}

export type AppEnv = ReturnType<typeof getEnv>;
