import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/connection";
import { SigningAccessError, getSigningDocumentForToken } from "@/lib/signing";
import { logRouteError } from "@/lib/security/logging";
import { applyRateLimit, buildRateLimitKey } from "@/lib/security/route-controls";
import { getClientIpAddress } from "@/lib/security/request";

type SigningDocumentRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

export async function GET(
  request: Request,
  context: SigningDocumentRouteContext,
) {
  const { token } = await context.params;
  const rateLimitResponse = await applyRateLimit({
    category: "signing_document_read",
    key: buildRateLimitKey([
      "signing-document",
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
    const documentObject = await getSigningDocumentForToken(token, {
      database: getDb(),
    });
    const responseBody = documentObject.body.slice().buffer as ArrayBuffer;

    return new Response(responseBody, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": 'inline; filename="document.pdf"',
        "content-length": String(
          documentObject.contentLength ?? documentObject.body.length,
        ),
        "content-type": documentObject.contentType ?? "application/pdf",
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
      category: "signing_document_read_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while loading a signing document.",
      path: request.url,
    });

    return NextResponse.json(
      {
        error: "Unable to load this document.",
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
