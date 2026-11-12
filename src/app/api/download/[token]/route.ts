import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/connection";
import { createDownloadResponse } from "@/lib/download-response";
import {
  DownloadAccessError,
  ExpiredDownloadLinkError,
  getPublicEnvelopeDownloadForToken,
} from "@/lib/downloads";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress } from "@/lib/security/request";
import { resolveAppUrl } from "@/lib/utils/env";

// Public download route for recipient email links only.
// Sender downloads must go through the authenticated /api/envelopes/[id]/download route.
type PublicDownloadRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

export async function GET(
  request: Request,
  context: PublicDownloadRouteContext,
) {
  const { token } = await context.params;
  const rateLimitResponse = await applyRateLimit({
    category: "public_download",
    key: buildRateLimitKey([
      "public-download",
      token,
      getClientIpAddress(request.headers) ?? "unknown",
    ]),
    limit: 20,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return new NextResponse("Too many requests. Please try again soon.", {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/plain; charset=utf-8",
        "retry-after": rateLimitResponse.headers.get("retry-after") ?? "60",
      },
      status: 429,
    });
  }

  try {
    const download = await getPublicEnvelopeDownloadForToken(token, {
      database: getDb(),
    });

    return await createDownloadResponse(download);
  } catch (error) {
    // The page there offers to email fresh links to the signer.
    if (error instanceof ExpiredDownloadLinkError) {
      return NextResponse.redirect(
        new URL(
          `/download/${encodeURIComponent(token)}`,
          resolveAppUrl() ?? request.url,
        ),
        { headers: { "cache-control": "private, no-store" }, status: 303 },
      );
    }

    if (error instanceof DownloadAccessError) {
      return new NextResponse(error.message, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": "text/plain; charset=utf-8",
        },
        status: error.statusCode,
      });
    }

    logRouteError(error, {
      category: "public_download_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while starting a recipient download.",
      path: request.url,
    });

    return new NextResponse("Unable to start this download.", {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/plain; charset=utf-8",
      },
      status: 500,
    });
  }
}
