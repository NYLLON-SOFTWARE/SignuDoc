import { NextResponse } from "next/server";

import { RateLimitExceededError, enforceSlidingWindowRateLimit } from "./rate-limit.ts";
import { logSecurityEvent } from "./logging.ts";
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

function getRetryAfterHeaders(retryAfterSeconds: number) {
  return {
    "retry-after": String(retryAfterSeconds),
  };
}

export function applyRateLimit(input: RateLimitInput): NextResponse | null {
  try {
    enforceSlidingWindowRateLimit({
      key: input.key,
      limit: input.limit,
      windowMs: input.windowMs,
    });

    return null;
  } catch (error) {
    if (!(error instanceof RateLimitExceededError)) {
      throw error;
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
        headers: getRetryAfterHeaders(error.retryAfterSeconds),
        status: 429,
      },
    );
  }
}

export function buildRateLimitKey(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(":");
}
