import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/connection";
import {
  ProviderSigningError,
  resumeProviderSigning,
} from "@/lib/provider-signing";
import { readCookie, verifiedMethodsFromCookies } from "@/lib/signer-checks";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestUserAgent,
} from "@/lib/security/request";

// The last signer's return also finishes the envelope: long-term validation
// asks certificate authorities, within 15 seconds, and the PDFs are stored.
export const maxDuration = 60;

function seeOther(location: string, request: Request) {
  return NextResponse.redirect(new URL(location, request.url), {
    headers: { "cache-control": "private, no-store" },
    status: 303,
  });
}

function endedPage() {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signing session ended</title></head><body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5"><h1 style="font-size: 1.25rem">This signing session has ended</h1><p>Nothing was signed. Open the signing link from your email again to sign.</p></body></html>`,
    {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/html; charset=utf-8",
      },
      status: 410,
    },
  );
}

/**
 * Where a signing provider sends the signer back. The state names the
 * signing session, which holds everything else.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");

  if (!state || state.length > 128) {
    return endedPage();
  }

  const rateLimitResponse = await applyRateLimit({
    category: "signing_submit",
    key: buildRateLimitKey([
      "signing-provider-return",
      getClientIpAddress(request.headers) ?? "unknown",
    ]),
    limit: 30,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const cookieHeader = request.headers.get("cookie");

  try {
    const next = await resumeProviderSigning(state, url.searchParams, {
      database: getDb(),
      requestMeta: {
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
      },
      verifiedMethodsFor: (token) =>
        verifiedMethodsFromCookies(token, (name) =>
          readCookie(cookieHeader, name),
        ),
    });

    return seeOther(
      "redirectUrl" in next ? next.redirectUrl : next.redirectPath,
      request,
    );
  } catch (error) {
    if (error instanceof ProviderSigningError) {
      if (!error.token) {
        return endedPage();
      }

      return seeOther(
        `/sign/${encodeURIComponent(error.token)}?signatureProblem=${error.problem}`,
        request,
      );
    }

    logRouteError(error, {
      category: "signing_submit_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure when a signer came back from a provider.",
      path: url.pathname,
    });

    return endedPage();
  }
}
