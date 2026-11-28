import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  EnvelopeDocumentAccessError,
  getDraftEnvelopeDocumentForUser,
} from "@/lib/envelopes";
import { resolveEnvelopeViewerAccess } from "@/lib/envelope-access";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { buildContentDisposition } from "@/lib/services/storage";
import { recordSystemAuditEvent } from "@/lib/services/system-audit";

type EnvelopeDocumentRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(
  request: Request,
  context: EnvelopeDocumentRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;

  try {
    const access = await resolveEnvelopeViewerAccess(
      session.user.id,
      id,
      getDb(),
    );
    if (!access) {
      throw new EnvelopeDocumentAccessError("Envelope not found.", 404);
    }

    const document = await getDraftEnvelopeDocumentForUser(
      access.ownerUserId,
      id,
      { database: getDb() },
    );

    if (!access.viewerIsOwner) {
      // An administrator or folder member opening someone else's document is
      // on record in the install's audit trail, as a download of its files
      // is. No record, no file.
      await recordSystemAuditEvent({
        actorEmail: session.user.email,
        actorUserId: session.user.id,
        event: "envelope_file_downloaded",
        ipAddress: getClientIpAddress(request.headers),
        metadata: {
          envelopeId: id,
          file: "original",
          ownerEmail: access.ownerEmail,
          ownerUserId: access.ownerUserId,
        },
        targetUserId: access.ownerUserId,
        userAgent: request.headers.get("user-agent"),
      });
    }

    const responseBody = document.body.slice().buffer as ArrayBuffer;

    return new Response(responseBody, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": buildContentDisposition(
          document.fileName,
          "inline",
        ),
        "content-length": String(document.contentLength),
        "content-type": document.contentType,
        "x-content-type-options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    if (error instanceof EnvelopeDocumentAccessError) {
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
      category: "draft_envelope_document_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while loading a draft envelope document.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to load this draft document." },
      {
        headers: {
          "cache-control": "private, no-store",
        },
        status: 500,
      },
    );
  }
}
