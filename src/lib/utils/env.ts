export type EnvSource = Readonly<Record<string, string | undefined>>;

export class MissingEnvError extends Error {
  constructor(variableName: string) {
    super(`Missing required environment variable: ${variableName}`);
    this.name = "MissingEnvError";
  }
}

function readEnv(env: EnvSource, variableName: string): string | undefined {
  const value = env[variableName];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function isLocalhostUrl(value: string): boolean {
  try {
    const parsedUrl = new URL(value);

    return (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function assertProductionHttpsUrl(
  variableName: string,
  value: string | undefined,
) {
  if (!value) {
    throw new MissingEnvError(variableName);
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(
      `${variableName} must be a valid absolute URL in production.`,
    );
  }

  if (parsedUrl.protocol !== "https:") {
    throw new Error(`${variableName} must use HTTPS in production.`);
  }

  if (isLocalhostUrl(value)) {
    throw new Error(`${variableName} must not use localhost in production.`);
  }
}

function assertStrongSecret(
  variableName: string,
  value: string | undefined,
  minimumLength = 32,
) {
  if (!value) {
    throw new MissingEnvError(variableName);
  }

  if (value.length < minimumLength) {
    throw new Error(
      `${variableName} must be at least ${String(minimumLength)} characters in production.`,
    );
  }
}

function assertProductionEnv(
  appEnv: ReturnType<typeof getEnv>,
  env: EnvSource,
) {
  if (env.NODE_ENV !== "production") {
    return;
  }

  assertProductionHttpsUrl("APP_URL", appEnv.appUrl);
  assertProductionHttpsUrl("BETTER_AUTH_URL", appEnv.auth.betterAuthUrl);
  assertStrongSecret("BETTER_AUTH_SECRET", appEnv.auth.betterAuthSecret);
}

export function hasEnv(
  variableName: string,
  env: EnvSource = process.env,
): boolean {
  return readEnv(env, variableName) !== undefined;
}

export function getEnv(env: EnvSource = process.env) {
  const appEnv = {
    databaseUrl: readEnv(env, "DATABASE_URL"),
    appUrl: readEnv(env, "APP_URL"),
    auth: {
      betterAuthSecret: readEnv(env, "BETTER_AUTH_SECRET"),
      betterAuthUrl: readEnv(env, "BETTER_AUTH_URL"),
    },
    email: {
      apiKey: readEnv(env, "RESEND_API_KEY"),
      senderAddress: readEnv(env, "RESEND_FROM_EMAIL"),
      supportAddress: readEnv(env, "SUPPORT_EMAIL"),
    },
    internal: {
      retentionJobSecret: readEnv(env, "RETENTION_JOB_SECRET"),
    },
    storage: {
      accountId: readEnv(env, "R2_ACCOUNT_ID"),
      accessKeyId: readEnv(env, "R2_ACCESS_KEY_ID"),
      bucketName: readEnv(env, "R2_BUCKET_NAME"),
      secretAccessKey: readEnv(env, "R2_SECRET_ACCESS_KEY"),
    },
  };

  assertProductionEnv(appEnv, env);

  return appEnv;
}

export type AppEnv = ReturnType<typeof getEnv>;
