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
import { resolveEnvelopeViewerAccess } from "@/lib/envelope-access";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { recordSystemAuditEvent } from "@/lib/services/system-audit";

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
    const access = await resolveEnvelopeViewerAccess(
      session.user.id,
      id,
      getDb(),
    );
    if (!access) {
      throw new DownloadAccessError("Envelope not found.", 404);
    }

    const download = await getSenderEnvelopeDownload(
      access.ownerUserId,
      id,
      type,
      {
        database: getDb(),
      },
    );

    if (!access.viewerIsOwner) {
      // An administrator or folder member taking a copy of someone else's
      // document is on record in the install's audit trail. No record, no
      // file.
      await recordSystemAuditEvent({
        actorEmail: session.user.email,
        actorUserId: session.user.id,
        event: "envelope_file_downloaded",
        ipAddress: getClientIpAddress(request.headers),
        metadata: {
          envelopeId: id,
          file: type,
          ownerEmail: access.ownerEmail,
          ownerUserId: access.ownerUserId,
        },
        targetUserId: access.ownerUserId,
        userAgent: request.headers.get("user-agent"),
      });
    }

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
