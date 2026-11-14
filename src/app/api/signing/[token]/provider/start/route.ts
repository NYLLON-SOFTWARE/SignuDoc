import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { getDb } from "@/lib/db/connection";
import { startProviderSigning } from "@/lib/provider-signing";
import {
  verificationRequiredResponse,
  verifiedMethodsForRequest,
} from "@/lib/signing-route";
import {
  SigningAccessError,
  SigningMutationError,
  SigningVerificationRequiredError,
} from "@/lib/signing";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress } from "@/lib/security/request";

// Preparing the signer's revision of the PDF and handing its hash to the
// signing provider can take a while on a long document.
export const maxDuration = 60;

type ProviderStartRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

const NO_STORE = { "cache-control": "private, no-store" };

/**
 * Starts a signature through the envelope's signing provider. Takes the
 * same body as submit, and answers where to send the signer.
 */
export async function POST(
  request: Request,
  context: ProviderStartRouteContext,
) {
  const { token } = await context.params;
  const rateLimitResponse = await applyRateLimit({
    category: "signing_submit",
    key: buildRateLimitKey([
      "signing-provider-start",
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
    const { redirectUrl } = await startProviderSigning(token, body, {
      database: getDb(),
      language: request.headers.get("accept-language")?.slice(0, 2) ?? null,
      verifiedMethods: verifiedMethodsForRequest(token, request),
    });

    return NextResponse.json(
      { redirectUrl },
      { headers: NO_STORE, status: 200 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid signing submission." },
        { headers: NO_STORE, status: 400 },
      );
    }

    if (error instanceof SigningVerificationRequiredError) {
      return verificationRequiredResponse(error);
    }

    if (error instanceof SigningAccessError) {
      return NextResponse.json(
        { error: error.message, state: error.state },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    if (error instanceof SigningMutationError) {
      return NextResponse.json(
        { error: error.message },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "signing_submit_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while starting a provider signature.",
      path: request.url,
    });

    return NextResponse.json(
      { error: "Unable to start signing." },
      { headers: NO_STORE, status: 500 },
    );
  }
}
