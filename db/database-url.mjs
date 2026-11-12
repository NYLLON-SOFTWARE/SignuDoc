// Finds the Postgres connection string in the environment and prepares it for
// the pg driver. Plain JavaScript so that both the app and db/migrate.mjs
// (which runs before anything is compiled) share one implementation.

/**
 * Environment variables that can hold the connection string, as pairs of
 * [the URL the app uses, a direct URL for migrations when there is one].
 * The first pair with a URL wins, so a URL someone set by hand as
 * DATABASE_URL is never paired with an unrelated POSTGRES_URL_NON_POOLING.
 *
 * - DATABASE_URL / DATABASE_URL_UNPOOLED: set by hand, or by Neon through
 *   the Vercel Marketplace.
 * - POSTGRES_URL / POSTGRES_URL_NON_POOLING: set by Supabase through the
 *   Vercel Marketplace.
 */
const DATABASE_URL_PAIRS = [
  ["DATABASE_URL", "DATABASE_URL_UNPOOLED"],
  ["POSTGRES_URL", "POSTGRES_URL_NON_POOLING"],
];

export const DATABASE_URL_VARIABLES = DATABASE_URL_PAIRS.map(
  ([runtimeName]) => runtimeName,
);

/**
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} name
 * @returns {string | undefined}
 */
function readConfiguredValue(env, name) {
  const value = env[name]?.trim();

  if (!value || value.toLowerCase().startsWith("replace-with-")) {
    return undefined;
  }

  return value;
}

/**
 * The connection string the running app should use.
 *
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @returns {{ name: string, value: string } | null}
 */
export function resolveDatabaseUrl(env = process.env) {
  for (const [runtimeName] of DATABASE_URL_PAIRS) {
    const value = readConfiguredValue(env, runtimeName);

    if (value) {
      return { name: runtimeName, value };
    }
  }

  return null;
}

/**
 * The connection string migrations should use. A direct connection is
 * preferred because session-level advisory locks and DDL are not reliable
 * through a transaction-mode pooler.
 *
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @returns {{ name: string, value: string } | null}
 */
export function resolveMigrationDatabaseUrl(env = process.env) {
  for (const [runtimeName, directName] of DATABASE_URL_PAIRS) {
    const runtimeValue = readConfiguredValue(env, runtimeName);

    if (!runtimeValue) {
      continue;
    }

    const directValue = readConfiguredValue(env, directName);

    return directValue
      ? { name: directName, value: directValue }
      : { name: runtimeName, value: runtimeValue };
  }

  return null;
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isSupabaseHost(hostname) {
  return (
    hostname.endsWith(".supabase.com") || hostname.endsWith(".supabase.co")
  );
}

/**
 * Makes the TLS behaviour of a connection string explicit.
 *
 * pg currently treats sslmode=require, prefer and verify-ca as verify-full
 * and prints a warning that this will change in its next major version.
 *
 * - For most hosts (Neon included) the URL is rewritten to sslmode=verify-full,
 *   which is what pg does today and keeps full certificate verification after
 *   that change.
 * - Supabase serves a certificate from its own authority, which Node does not
 *   trust by default, so verify-full fails there. For Supabase hosts a URL
 *   that says require or prefer gets libpq semantics instead, where those
 *   modes mean "encrypt, do not verify", exactly as psql and Supabase's own
 *   documentation read them. A Supabase URL that asks for verify-ca is left
 *   alone: that is an explicit request for certificate checks, which pg
 *   honours once Supabase's CA is trusted (sslrootcert or NODE_EXTRA_CA_CERTS).
 *
 * A URL that already says uselibpqcompat, verify-full, no-verify or disable,
 * or has no sslmode at all, is returned unchanged.
 *
 * @param {string} connectionString
 * @returns {string}
 */
export function normalizeDatabaseUrl(connectionString) {
  /** @type {URL} */
  let url;

  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  const sslMode = url.searchParams.get("sslmode");

  if (
    url.searchParams.has("uselibpqcompat") ||
    (sslMode !== "require" && sslMode !== "prefer" && sslMode !== "verify-ca")
  ) {
    return connectionString;
  }

  if (isSupabaseHost(url.hostname)) {
    if (sslMode === "verify-ca") {
      // Never weaken a mode that asks for certificate verification.
      return connectionString;
    }

    url.searchParams.set("uselibpqcompat", "true");
    url.searchParams.set("sslmode", "require");
  } else {
    url.searchParams.set("sslmode", "verify-full");
  }

  return url.toString();
}

/**
 * The password inside a connection string, or undefined if there is none.
 *
 * @param {string} connectionString
 * @returns {string | undefined}
 */
export function readDatabasePassword(connectionString) {
  try {
    const password = decodeURIComponent(new URL(connectionString).password);

    return password.length > 0 ? password : undefined;
  } catch {
    return undefined;
  }
}
