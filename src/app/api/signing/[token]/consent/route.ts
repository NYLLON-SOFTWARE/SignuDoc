import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { getDb } from "@/lib/db/connection";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestUserAgent,
} from "@/lib/security/request";
import {
  recordSignerConsent,
  SigningAccessError,
  SigningMutationError,
  SigningVerificationRequiredError,
} from "@/lib/signing";
import {
  verificationRequiredResponse,
  verifiedMethodsForRequest,
} from "@/lib/signing-route";

type ConsentRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

const NO_STORE = { "cache-control": "private, no-store" };

export async function POST(request: Request, context: ConsentRouteContext) {
  const { token } = await context.params;
  const rateLimitResponse = await applyRateLimit({
    category: "signing_consent",
    key: buildRateLimitKey([
      "signing-consent",
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

  try {
    return NextResponse.json(
      await recordSignerConsent(token, await request.json().catch(() => null), {
        database: getDb(),
        requestMeta: {
          ipAddress: getClientIpAddress(request.headers),
          userAgent: getRequestUserAgent(request.headers),
        },
        verifiedMethods: verifiedMethodsForRequest(token, request),
      }),
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "Invalid request." },
        { headers: NO_STORE, status: 400 },
      );
    }

    if (error instanceof SigningVerificationRequiredError) {
      return verificationRequiredResponse(error);
    }

    if (error instanceof SigningMutationError) {
      return NextResponse.json(
        { error: error.message },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    if (error instanceof SigningAccessError) {
      return NextResponse.json(
        { error: error.message, state: error.state },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "signing_consent_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while recording consent.",
      path: request.url,
    });

    return NextResponse.json(
      { error: "Your agreement could not be saved right now." },
      { headers: NO_STORE, status: 500 },
    );
  }
}
