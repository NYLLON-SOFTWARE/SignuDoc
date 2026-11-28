import { NextResponse } from "next/server";

import { AuditExportError, exportEnvelopeAuditCsv } from "@/lib/audit-export";
import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { resolveEnvelopeViewerAccess } from "@/lib/envelope-access";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { buildContentDisposition } from "@/lib/services/storage";
import { recordSystemAuditEvent } from "@/lib/services/system-audit";

type EnvelopeAuditRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// The envelope's audit trail as a CSV file for an authorized viewer.
export async function GET(
  request: Request,
  context: EnvelopeAuditRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const { id } = await context.params;

  try {
    const access = await resolveEnvelopeViewerAccess(sessionResult.user.id, id);
    if (!access) {
      throw new AuditExportError("Envelope not found.", 404);
    }

    const file = await exportEnvelopeAuditCsv(access.ownerUserId, id);

    if (!access.viewerIsOwner) {
      // An administrator or folder member taking a copy of someone else's
      // records is on record in the install's audit trail. No record, no
      // file.
      await recordSystemAuditEvent({
        actorEmail: sessionResult.user.email,
        actorUserId: sessionResult.user.id,
        event: "envelope_file_downloaded",
        ipAddress: getClientIpAddress(request.headers),
        metadata: {
          envelopeId: id,
          file: "audit_trail",
          ownerEmail: access.ownerEmail,
          ownerUserId: access.ownerUserId,
        },
        targetUserId: access.ownerUserId,
        userAgent: request.headers.get("user-agent"),
      });
    }

    return new Response(file.body, {
      headers: {
        "cache-control": "private, no-store",
        // The name comes from the envelope's title, which may hold
        // characters a header cannot carry as they are.
        "content-disposition": buildContentDisposition(file.fileName),
        "content-type": "text/csv; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AuditExportError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "envelope_audit_export_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while exporting an audit trail.",
      path: getRequestPathname(request),
      userId: sessionResult.user.id,
    });

    return NextResponse.json(
      { error: "The audit trail could not be exported." },
      { status: 500 },
    );
  }
}
