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
import { hashOpaqueToken } from "@/lib/services/opaque-tokens";
import {
  buildVerificationCookieValue,
  verificationCookieName,
} from "@/lib/signer-checks";
import {
  SigningAccessError,
  SigningMutationError,
  verifySignerCheck,
} from "@/lib/signing";
import { verifiedMethodsForRequest } from "@/lib/signing-route";
import { resolveAppUrl } from "@/lib/utils/env";

type VerifyRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

const NO_STORE = { "cache-control": "private, no-store" };

export async function POST(request: Request, context: VerifyRouteContext) {
  const { token } = await context.params;
  // Codes are short: few tries per link, whatever address they come from.
  const rateLimitResponse = await applyRateLimit({
    category: "signing_verify",
    key: buildRateLimitKey(["signing-verify", token]),
    limit: 10,
    message: "Too many tries. Wait a few minutes and try again.",
    request,
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const methods = await verifySignerCheck(
      token,
      await request.json().catch(() => null),
      {
        database: getDb(),
        requestMeta: {
          ipAddress: getClientIpAddress(request.headers),
          userAgent: getRequestUserAgent(request.headers),
        },
        verifiedMethods: verifiedMethodsForRequest(token, request),
      },
    );
    const tokenHash = hashOpaqueToken(token);
    const cookie = buildVerificationCookieValue(tokenHash, methods);
    const response = NextResponse.json(
      { verified: methods },
      { headers: NO_STORE },
    );

    response.cookies.set(verificationCookieName(tokenHash), cookie.value, {
      httpOnly: true,
      maxAge: cookie.maxAge,
      path: "/",
      sameSite: "lax",
      secure: resolveAppUrl()?.startsWith("https://") ?? false,
    });

    return response;
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "Enter the code." },
        { headers: NO_STORE, status: 400 },
      );
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
      category: "signing_verify_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while checking a signer code.",
      path: request.url,
    });

    return NextResponse.json(
      { error: "The code could not be checked right now." },
      { headers: NO_STORE, status: 500 },
    );
  }
}
