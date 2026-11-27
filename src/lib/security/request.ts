import { isIP } from "node:net";

import {
  findInvalidTrustedProxies,
  getIPFromHeader,
} from "@better-auth/core/utils/ip";

type IpEnv = Record<string, string | undefined>;

function firstAddress(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

/** An address on a private network, or the machine itself. */
function isInternalAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);

    return (
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (version === 6) {
    const lower = address.toLowerCase();

    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.")
    );
  }

  return false;
}

/**
 * The visitor's address from an X-Forwarded-For list. Each proxy adds the
 * address it was reached from at the end, so anything at the start may be
 * the visitor's own invention. Read from the end, passing over the
 * install's own proxies on a private network: the first address left is
 * the one the outermost proxy saw.
 */
function forwardedForAddress(value: string | null): string | null {
  const addresses = (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const address = addresses[index]!;

    if (!isInternalAddress(address)) {
      return address;
    }
  }

  return addresses[0] ?? null;
}

/**
 * Which header an install's own reverse proxy writes the visitor's address
 * to, read from CLIENT_IP_HEADER, and for an X-Forwarded-For list the
 * proxies (TRUSTED_PROXIES, addresses or CIDR ranges) whose entries at its
 * end are passed over. Null when the install has not said, and always on
 * Vercel, whose own header is trusted instead.
 *
 * A value that cannot be right throws, so a typo stops the app with a
 * message instead of leaving it reading headers anyone can send.
 */
export type ClientIpSettings = { header: string; trustedProxies: string[] };

const HEADER_NAME_PATTERN = /^[a-z0-9-]+$/;

export function readClientIpSettings(
  env: IpEnv = process.env,
): ClientIpSettings | null {
  if (env.VERCEL === "1") {
    return null;
  }

  const header = env.CLIENT_IP_HEADER?.trim().toLowerCase();
  const trustedProxies = (env.TRUSTED_PROXIES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!header) {
    if (trustedProxies.length > 0) {
      throw new Error(
        "TRUSTED_PROXIES is set but CLIENT_IP_HEADER is not. Set CLIENT_IP_HEADER to the header your reverse proxy writes the visitor's address to.",
      );
    }

    return null;
  }

  if (!HEADER_NAME_PATTERN.test(header)) {
    throw new Error(
      `CLIENT_IP_HEADER must be a header name, such as x-real-ip or x-forwarded-for, not "${header}".`,
    );
  }

  const invalid = findInvalidTrustedProxies(trustedProxies);

  if (invalid.length > 0) {
    throw new Error(
      `TRUSTED_PROXIES must list addresses or CIDR ranges. These are neither: ${invalid.join(", ")}.`,
    );
  }

  return { header, trustedProxies };
}

let warnedUnconfigured = false;

/**
 * Said once per process, in production away from Vercel, while the install
 * still guesses the visitor's address from headers a visitor can also send.
 */
function warnUnconfiguredOnce(env: IpEnv) {
  if (warnedUnconfigured || env.NODE_ENV !== "production") {
    return;
  }

  warnedUnconfigured = true;
  console.warn(
    "[security] CLIENT_IP_HEADER is not set, so visitors' addresses are guessed from X-Forwarded-For, CF-Connecting-IP and X-Real-IP, which a visitor can also send. Rate limits can then be dodged and the audit trail can record a forged address. Set CLIENT_IP_HEADER (and TRUSTED_PROXIES for X-Forwarded-For) to match your reverse proxy; see docs/self-hosting.md.",
  );
}

/**
 * The headers that carry the visitor's address, most trustworthy first.
 *
 * On Vercel, x-vercel-forwarded-for and x-real-ip are written by Vercel
 * itself and cannot be set by the visitor, so they come first.
 * https://vercel.com/docs/headers/request-headers
 *
 * Anywhere else, with CLIENT_IP_HEADER set, that one header and nothing
 * else: the install's proxy writes it over whatever the visitor sent.
 *
 * Without it, those names mean nothing special and anyone could send them,
 * so the usual proxy headers are tried in turn. X-Forwarded-For is read
 * from its end (see forwardedForAddress), so what a visitor puts at its
 * start does not count, but a visitor can still send the other two.
 */
export function getClientIpHeaderNames(env: IpEnv = process.env): string[] {
  if (env.VERCEL === "1") {
    return ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"];
  }

  const settings = readClientIpSettings(env);

  return settings
    ? [settings.header]
    : ["x-forwarded-for", "cf-connecting-ip", "x-real-ip"];
}

export function getClientIpAddress(
  headers: Headers,
  env: IpEnv = process.env,
): string | null {
  const offVercel = env.VERCEL !== "1";
  const settings = readClientIpSettings(env);

  if (settings) {
    const value = headers.get(settings.header);

    // Better Auth's reading of the same header, so the app's own rate
    // limits and audit records name the same visitor its sign-in limits
    // do. A list is walked from its end past the trusted proxies; a single
    // value must be one address. Full IPv6 addresses, for the audit trail.
    return value
      ? getIPFromHeader(value, {
          ipv6Subnet: 128,
          trustedProxies: settings.trustedProxies,
        })
      : null;
  }

  if (offVercel) {
    warnUnconfiguredOnce(env);
  }

  for (const name of getClientIpHeaderNames(env)) {
    const address =
      offVercel && name === "x-forwarded-for"
        ? forwardedForAddress(headers.get(name))
        : firstAddress(headers.get(name));

    if (address) {
      return address;
    }
  }

  return null;
}

export function getRequestUserAgent(headers: Headers): string | null {
  // A header sent with no value reads as "", which the audit schema
  // rejects; it counts as no user agent at all.
  return headers.get("user-agent")?.trim() || null;
}

/** Who made a request, as the audit trail records it. */
export type RequestClient = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export function getRequestClient(
  headers: Headers | null | undefined,
  env: IpEnv = process.env,
): { ipAddress: string | null; userAgent: string | null } {
  if (!headers) {
    return { ipAddress: null, userAgent: null };
  }

  return {
    ipAddress: getClientIpAddress(headers, env),
    userAgent: getRequestUserAgent(headers),
  };
}

export function getRequestPathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}
