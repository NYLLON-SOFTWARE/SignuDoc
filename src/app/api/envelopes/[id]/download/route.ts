import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  DownloadAccessError,
  getSenderEnvelopeDownload,
} from "@/lib/downloads";
import { downloadRequestSchema } from "@/lib/schemas/envelope";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { buildContentDisposition } from "@/lib/services/storage";
import { createStorageService } from "@/lib/services/storage";

const PRESIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;

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

    if (!("body" in download)) {
      const presignedDownload =
        await createStorageService().createPresignedDownloadUrl({
          expiresInSeconds: PRESIGNED_DOWNLOAD_TTL_SECONDS,
          fileName: download.fileName,
          key: download.key,
        });

      return NextResponse.redirect(
        new URL(presignedDownload.url, request.url),
        {
          headers: {
            "cache-control": "private, no-store",
          },
          status: 302,
        },
      );
    }

    const responseBody = download.body.slice().buffer as ArrayBuffer;

    return new Response(responseBody, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": buildContentDisposition(download.fileName),
        "content-length": String(download.contentLength),
        "content-type": download.contentType,
      },
      status: 200,
    });
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
