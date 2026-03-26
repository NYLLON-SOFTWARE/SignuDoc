import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { getDb } from "@/lib/db/connection";
import {
  SigningAccessError,
  SigningMutationError,
  submitSigningForToken,
} from "@/lib/signing";
import { logRouteError } from "@/lib/security/logging";
import { applyRateLimit, buildRateLimitKey } from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestUserAgent } from "@/lib/security/request";

type SigningSubmitRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

export async function POST(
  request: Request,
  context: SigningSubmitRouteContext,
) {
  const { token } = await context.params;
  const rateLimitResponse = applyRateLimit({
    category: "signing_submit",
    key: buildRateLimitKey([
      "signing-submit",
      token,
      getClientIpAddress(request.headers) ?? "unknown",
    ]),
    limit: 10,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }
  const body = (await request.json().catch(() => null)) as unknown;

  try {
    const payload = await submitSigningForToken(token, body, {
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
    if (error instanceof ZodError) {
      const issue = error.issues[0];

      return NextResponse.json(
        {
          error: issue?.message ?? "Invalid signing submission.",
        },
        {
          headers: {
            "cache-control": "private, no-store",
          },
          status: 400,
        },
      );
    }

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

    if (error instanceof SigningMutationError) {
      return NextResponse.json(
        {
          error: error.message,
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
      category: "signing_submit_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while submitting a signing action.",
      path: request.url,
    });

    return NextResponse.json(
      {
        error: "Unable to finish signing.",
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
