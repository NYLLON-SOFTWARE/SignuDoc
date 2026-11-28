import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  handleTeamChange,
  isFolderRequest,
  respondWithTeams,
} from "@/lib/team-routes";
import { createTeam } from "@/lib/teams";

// The install's teams, for Settings. Administrators only.

export async function GET(request: Request) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  try {
    return await respondWithTeams(request);
  } catch (error) {
    logRouteError(error, {
      category: "team_list_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while listing teams.",
      path: getRequestPathname(request),
      userId: sessionResult.user.id,
    });

    return NextResponse.json(
      { error: "The teams could not be loaded." },
      { status: 500 },
    );
  }
}

// Makes a team: { name }. Administrators only.
export async function POST(request: Request) {
  return handleTeamChange(request, "team_create_failure", async (actor, body) =>
    createTeam(actor, await body(), undefined, isFolderRequest(request)),
  );
}
