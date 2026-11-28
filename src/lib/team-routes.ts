import { NextResponse } from "next/server";

import { requireAdminSession } from "./auth/admin.ts";
import { logRouteError } from "./security/logging.ts";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "./security/route-controls.ts";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "./security/request.ts";
import { listTeams, TeamError, type TeamActor } from "./teams.ts";
import { readLimitedBody } from "./utils/limited-body.ts";

// What the routes under /api/admin/teams share: an administrator's session,
// a rate limit on changes, and the answer, which is always the list of
// teams as it now stands.

const noStore = { "cache-control": "private, no-store" };

export function isFolderRequest(request: Request): boolean {
  return new URL(request.url).searchParams.get("kind") === "folder";
}

export async function respondWithTeams(request: Request, status = 200) {
  return NextResponse.json(
    { teams: await listTeams(undefined, isFolderRequest(request)) },
    { headers: noStore, status },
  );
}

/**
 * Runs one change to the teams for an administrator, and answers with the
 * list after it. `change` gets who is making it, for the audit trail, and
 * reads the request's JSON body only once the session and the rate limit
 * have let the request through.
 */
export async function handleTeamChange(
  request: Request,
  category: string,
  change: (actor: TeamActor, body: () => Promise<unknown>) => Promise<unknown>,
) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const rateLimitResponse = await applyRateLimit({
    category: "team_change",
    key: buildRateLimitKey(["team-change", sessionResult.user.id]),
    limit: 120,
    request,
    userId: sessionResult.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    await change(
      {
        email: sessionResult.user.email,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
        userId: sessionResult.user.id,
      },
      () => readJsonBody(request),
    );

    return await respondWithTeams(request);
  } catch (error) {
    if (error instanceof TeamError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category,
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while changing a team.",
      path: getRequestPathname(request),
      userId: sessionResult.user.id,
    });

    return NextResponse.json(
      { error: "That change could not be saved." },
      { headers: noStore, status: 500 },
    );
  }
}

/** A team's name, or an email address: nothing needs more than this. */
const MAX_BODY_BYTES = 16 * 1024;

/** The JSON body, or null when it is too large or not JSON. */
async function readJsonBody(request: Request): Promise<unknown> {
  const body = await readLimitedBody(request, MAX_BODY_BYTES).catch(() => null);

  if (!body) {
    return null;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}
