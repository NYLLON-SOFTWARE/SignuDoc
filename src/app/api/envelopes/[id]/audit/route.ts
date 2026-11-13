import { NextResponse } from "next/server";

import { AuditExportError, exportEnvelopeAuditCsv } from "@/lib/audit-export";
import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

type EnvelopeAuditRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// The envelope's audit trail as a CSV file, for its sender.
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
    const file = await exportEnvelopeAuditCsv(sessionResult.user.id, id);

    return new Response(file.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${file.fileName}"`,
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
