import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { createDownloadResponse } from "@/lib/download-response";
import {
  DownloadAccessError,
  getSenderEnvelopeDownload,
} from "@/lib/downloads";
import { downloadRequestSchema } from "@/lib/schemas/envelope";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

type EnvelopeDownloadRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

function getDownloadType(request: Request) {
  const requestUrl = new URL(request.url);

  return requestUrl.searchParams.get("type");
}

export async function GET(
  request: Request,
  context: EnvelopeDownloadRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;

  try {
    const { type } = downloadRequestSchema.parse({
      type: getDownloadType(request),
    });
    const download = await getSenderEnvelopeDownload(
      session.user.id,
      id,
      type,
      {
        database: getDb(),
      },
    );

    return await createDownloadResponse(download);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];

      return NextResponse.json(
        { error: issue?.message ?? "Invalid download request." },
        { status: 400 },
      );
    }

    if (error instanceof DownloadAccessError) {
      return NextResponse.json(
        { error: error.message },
        {
          headers: {
            "cache-control": "private, no-store",
          },
          status: error.statusCode,
        },
      );
    }

    logRouteError(error, {
      category: "sender_envelope_download_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while generating a sender download.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to start this download." },
      {
        headers: {
          "cache-control": "private, no-store",
        },
        status: 500,
      },
    );
  }
}
