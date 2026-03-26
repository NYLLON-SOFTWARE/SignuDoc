import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/connection";
import { SigningAccessError, getSigningPayloadForToken } from "@/lib/signing";
import { logRouteError } from "@/lib/security/logging";
import { applyRateLimit, buildRateLimitKey } from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestUserAgent } from "@/lib/security/request";

type SigningRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

export async function GET(request: Request, context: SigningRouteContext) {
  const { token } = await context.params;
  const rateLimitResponse = applyRateLimit({
    category: "signing_token_read",
    key: buildRateLimitKey([
      "signing-read",
      token,
      getClientIpAddress(request.headers) ?? "unknown",
    ]),
    limit: 60,
    request,
    windowMs: 5 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const payload = await getSigningPayloadForToken(token, {
      database: getDb(),
      requestMeta: {
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
      },
    });

    return NextResponse.json(payload, {
      headers: {
        "cache-control": "private, no-store",
      },
      status: 200,
    });
  } catch (error) {
    if (error instanceof SigningAccessError) {
      return NextResponse.json(
        {
          error: error.message,
          state: error.state,
        },
        {
          headers: {
            "cache-control": "private, no-store",
          },
          status: error.statusCode,
        },
      );
    }

    logRouteError(error, {
      category: "signing_token_read_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while loading a signing link.",
      path: request.url,
    });

    return NextResponse.json(
      {
        error: "Unable to load this signing link.",
      },
      {
        headers: {
          "cache-control": "private, no-store",
        },
        status: 500,
      },
    );
  }
}
