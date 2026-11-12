import { NextResponse } from "next/server";

import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";
import { verifyDocumentHash, verifyRequestSchema } from "@/lib/verify";

export async function POST(request: Request) {
  const rateLimitResponse = await applyRateLimit({
    category: "document_verify",
    key: buildRateLimitKey([
      "document-verify",
      getClientIpAddress(request.headers) ??
        getRequestUserAgent(request.headers) ??
        "unknown",
    ]),
    limit: 30,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const parsed = verifyRequestSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Send the file's SHA-256 value." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await verifyDocumentHash(parsed.data.sha256), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    logRouteError(error, {
      category: "document_verify_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while checking a document.",
      path: getRequestPathname(request),
    });
    return NextResponse.json(
      { error: "The file could not be checked right now." },
      { status: 500 },
    );
  }
}
