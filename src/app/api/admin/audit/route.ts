import { NextResponse } from "next/server";

import { exportSystemAuditCsv } from "@/lib/audit-export";
import { requireAdminSession } from "@/lib/auth/admin";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  listSystemAuditEvents,
  verifySystemAuditChain,
} from "@/lib/services/system-audit";

const noStore = { "cache-control": "private, no-store" };

function readTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

// The install's own audit trail, for administrators. ?format=csv&from=&to=
// (ISO dates) downloads a range; otherwise a page of the newest events,
// with ?before=<sequence> for the next page.
export async function GET(request: Request) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const url = new URL(request.url);

  try {
    if (url.searchParams.get("format") === "csv") {
      const to =
        readTimestamp(url.searchParams.get("to")) ??
        Math.floor(Date.now() / 1000);
      const from = readTimestamp(url.searchParams.get("from")) ?? 0;
      const file = await exportSystemAuditCsv({ from, to });

      return new Response(file.body, {
        headers: {
          ...noStore,
          "content-disposition": `attachment; filename="${file.fileName}"`,
          "content-type": "text/csv; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const before = Number(url.searchParams.get("before"));
    const events = await listSystemAuditEvents({
      before: Number.isInteger(before) && before > 0 ? before : null,
      limit: 50,
    });

    return NextResponse.json(
      { chain: await verifySystemAuditChain(), events },
      { headers: noStore },
    );
  } catch (error) {
    logRouteError(error, {
      category: "system_audit_read_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while reading the install's audit trail.",
      path: getRequestPathname(request),
      userId: sessionResult.user.id,
    });

    return NextResponse.json(
      { error: "The audit trail could not be read." },
      { headers: noStore, status: 500 },
    );
  }
}
