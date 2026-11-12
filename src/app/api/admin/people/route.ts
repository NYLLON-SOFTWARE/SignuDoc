import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { listPeople } from "@/lib/people";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// The accounts on this install, for the People list in Settings.
// Administrators only.

export async function GET(request: Request) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  try {
    return NextResponse.json(
      { people: await listPeople(), you: sessionResult.user.id },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    logRouteError(error, {
      category: "people_list_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while listing accounts.",
      path: getRequestPathname(request),
      userId: sessionResult.user.id,
    });

    return NextResponse.json(
      { error: "The list of people could not be loaded." },
      { status: 500 },
    );
  }
}
