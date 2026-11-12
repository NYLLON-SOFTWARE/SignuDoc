import {
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { type DbExecutor, getDb, queryOne } from "./db/connection.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";
import { resolveAuthSecret } from "./utils/env.ts";

// Extra checks a sender can ask for before a signer may open and sign:
//
// - access_code: a code the sender tells the signer some other way (by
//   phone, in person). Proves more than holding the email.
// - email_code: a one-time code emailed when the signer opens the link.
//   Proves the person signing controls the mailbox at that moment, not just
//   that they hold a forwarded link.
//
// Passing a check sets a cookie for this link only, valid for a few hours.

export const signerCheckMethods = ["access_code", "email_code"] as const;
export type SignerCheckMethod = (typeof signerCheckMethods)[number];

export const EMAIL_CODE_TTL_SECONDS = 10 * 60;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_RESEND_SECONDS = 60;
const VERIFICATION_COOKIE_TTL_SECONDS = 8 * 60 * 60;
const COOKIE_CONTEXT = "signudoc/signer-verification/v1";

export type SignerCheckState = {
  accessCodeHash: string | null;
  consentedAt: number | null;
  emailCodeAttempts: number;
  emailCodeExpiresAt: number | null;
  emailCodeHash: string | null;
  emailCodeSentAt: number | null;
  requireEmailCode: boolean;
};

export async function getSignerCheckState(
  signerId: string,
  database: DbExecutor = getDb(),
): Promise<SignerCheckState> {
  const row = await queryOne<SignerCheckState>(
    database,
    `
      SELECT
        access_code_hash AS "accessCodeHash",
        consented_at AS "consentedAt",
        email_code_attempts AS "emailCodeAttempts",
        email_code_expires_at AS "emailCodeExpiresAt",
        email_code_hash AS "emailCodeHash",
        email_code_sent_at AS "emailCodeSentAt",
        require_email_code AS "requireEmailCode"
      FROM signers
      WHERE id = $1
    `,
    [signerId],
  );

  return (
    row ?? {
      accessCodeHash: null,
      consentedAt: null,
      emailCodeAttempts: 0,
      emailCodeExpiresAt: null,
      emailCodeHash: null,
      emailCodeSentAt: null,
      requireEmailCode: false,
    }
  );
}

export function requiredSignerChecks(
  state: Pick<SignerCheckState, "accessCodeHash" | "requireEmailCode">,
): SignerCheckMethod[] {
  return [
    ...(state.accessCodeHash ? (["access_code"] as const) : []),
    ...(state.requireEmailCode ? (["email_code"] as const) : []),
  ];
}

/** Access codes are short, so they are stored with a slow, salted hash. */
export function hashAccessCode(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(normalizeCode(code), salt, 32);

  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function normalizeCode(code: string): string {
  return code.trim().replace(/\s+/g, "").toUpperCase();
}

export function checkAccessCode(code: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");

  if (scheme !== "scrypt" || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(
    normalizeCode(code),
    Buffer.from(salt, "base64"),
    expected.length,
  );

  return timingSafeEqual(actual, expected);
}

export function issueEmailCode(): { code: string; hash: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

  return { code, hash: hashEmailCode(code) };
}

export function hashEmailCode(code: string): string {
  return createHmac("sha256", cookieSecret())
    .update(`email-code:${normalizeCode(code)}`)
    .digest("hex");
}

export function checkEmailCode(code: string, storedHash: string): boolean {
  const actual = Buffer.from(hashEmailCode(code), "hex");
  const expected = Buffer.from(storedHash, "hex");

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cookieSecret(): string {
  return resolveAuthSecret() ?? "signudoc-development-only";
}

export function verificationCookieName(signingTokenHash: string): string {
  return `sd_v_${signingTokenHash.slice(0, 16)}`;
}

function signCookie(
  signingTokenHash: string,
  expiresAt: number,
  methods: readonly SignerCheckMethod[],
): string {
  return createHmac("sha256", cookieSecret())
    .update(COOKIE_CONTEXT)
    .update(`|${signingTokenHash}|${String(expiresAt)}|${methods.join("+")}`)
    .digest("base64url");
}

export function buildVerificationCookieValue(
  signingTokenHash: string,
  methods: readonly SignerCheckMethod[],
  now = Math.floor(Date.now() / 1000),
): { maxAge: number; value: string } {
  const expiresAt = now + VERIFICATION_COOKIE_TTL_SECONDS;
  const sorted = [...new Set(methods)].sort();

  return {
    maxAge: VERIFICATION_COOKIE_TTL_SECONDS,
    value: `${String(expiresAt)}.${sorted.join("+")}.${signCookie(signingTokenHash, expiresAt, sorted)}`,
  };
}

export function readVerifiedMethods(
  signingTokenHash: string,
  cookieValue: string | null | undefined,
  now = Math.floor(Date.now() / 1000),
): SignerCheckMethod[] {
  if (!cookieValue) {
    return [];
  }

  const [expiresText, methodsText, signature] = cookieValue.split(".");
  const expiresAt = Number(expiresText);

  if (!signature || !Number.isFinite(expiresAt) || expiresAt < now) {
    return [];
  }

  const methods = (methodsText ?? "")
    .split("+")
    .filter((method): method is SignerCheckMethod =>
      (signerCheckMethods as readonly string[]).includes(method),
    );
  const expected = Buffer.from(
    signCookie(signingTokenHash, expiresAt, methods),
  );
  const actual = Buffer.from(signature);

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return [];
  }

  return methods;
}

/** Reads one cookie from a Cookie header. */
export function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}

/** The checks a browser has passed for this signing link, from its cookie. */
export function verifiedMethodsFromCookies(
  token: string,
  readCookieValue: (name: string) => string | null | undefined,
): SignerCheckMethod[] {
  const tokenHash = hashOpaqueToken(token);

  return readVerifiedMethods(
    tokenHash,
    readCookieValue(verificationCookieName(tokenHash)),
  );
}

export function maskEmailAddress(email: string): string {
  const [local = "", domain = ""] = email.split("@");

  return `${local.slice(0, 1)}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}
