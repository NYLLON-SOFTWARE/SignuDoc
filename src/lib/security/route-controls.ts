import { NextResponse } from "next/server";

import { logSecurityEvent } from "./logging.ts";
import { consumeRateLimit } from "./rate-limit.ts";
import { getClientIpAddress, getRequestPathname } from "./request.ts";

type RateLimitInput = {
  category: string;
  key: string;
  limit: number;
  message?: string;
  request: Request;
  userId?: string | null;
  windowMs: number;
};

/**
 * Counts this request against a limit. Returns the 429 response to send when
 * it is over, or null when the request may go ahead.
 */
export async function applyRateLimit(
  input: RateLimitInput,
): Promise<NextResponse | null> {
  const decision = await consumeRateLimit({
    key: input.key,
    limit: input.limit,
    windowMs: input.windowMs,
  });

  if (decision.allowed) {
    return null;
  }

  logSecurityEvent("warn", {
    category: input.category,
    ipAddress: getClientIpAddress(input.request.headers),
    message: "Rate limit exceeded.",
    path: getRequestPathname(input.request),
    userId: input.userId ?? null,
  });

  return NextResponse.json(
    {
      error: input.message ?? "Too many requests. Please try again soon.",
    },
    {
      headers: { "retry-after": String(decision.retryAfterSeconds) },
      status: 429,
    },
  );
}

export function buildRateLimitKey(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(":");
}
