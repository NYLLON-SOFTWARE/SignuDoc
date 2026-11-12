import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/connection";
import { sendFreshDownloadLinks } from "@/lib/download-renewal";
import { DownloadAccessError } from "@/lib/downloads";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress } from "@/lib/security/request";

type RenewRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

const NO_STORE = { "cache-control": "private, no-store" };

export async function POST(request: Request, context: RenewRouteContext) {
  const { token } = await context.params;
  const rateLimitResponse = await applyRateLimit({
    category: "download_link_renewal",
    // Per link, not per address: each request sends an email.
    key: buildRateLimitKey(["download-renew", token]),
    limit: 3,
    message: "A new link was sent recently. Check your email.",
    request,
    windowMs: 60 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const result = await sendFreshDownloadLinks(token, { database: getDb() });

    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof DownloadAccessError) {
      return NextResponse.json(
        { error: error.message },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "download_link_renewal_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while sending new download links.",
      path: "/api/download/[token]/renew",
    });

    return NextResponse.json(
      { error: "New links could not be sent right now." },
      { headers: NO_STORE, status: 500 },
    );
  }
}
