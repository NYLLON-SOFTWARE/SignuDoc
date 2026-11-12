import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  authorizeDirectUpload,
  DirectUploadRequestError,
} from "@/lib/services/direct-upload";
import { supportsDirectUploads } from "@/lib/services/storage";

// Hands the browser a short-lived signed URL for sending one PDF straight to
// Vercel Blob. Called by the Blob SDK from the upload page, never by hand.
export async function POST(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = applyRateLimit({
    category: "direct_upload_authorize",
    key: buildRateLimitKey(["direct-upload", session.user.id]),
    limit: 30,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  if (!supportsDirectUploads()) {
    return NextResponse.json(
      { error: "Direct uploads are not available on this install." },
      { status: 404 },
    );
  }

  try {
    return NextResponse.json(
      await authorizeDirectUpload({
        body: await request.json().catch(() => null),
        request,
        userId: session.user.id,
      }),
    );
  } catch (error) {
    if (error instanceof DirectUploadRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logRouteError(error, {
      category: "direct_upload_authorize_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while authorizing a direct upload.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to start the upload." },
      { status: 500 },
    );
  }
}
