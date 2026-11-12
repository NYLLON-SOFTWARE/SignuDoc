import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  listPeople,
  parsePersonRole,
  PeopleError,
  setPersonRole,
} from "@/lib/people";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

type PersonRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const noStore = { "cache-control": "private, no-store" };

// Makes an account an administrator or an ordinary account again.
// Administrators only. Answers with the whole list as it now stands.
export async function PATCH(request: Request, context: PersonRouteContext) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = await applyRateLimit({
    category: "people_role_change",
    key: buildRateLimitKey(["people-role", session.user.id]),
    limit: 30,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const body = (await request.json().catch(() => null)) as {
    role?: unknown;
  } | null;
  const role = parsePersonRole(body?.role);

  if (!role) {
    return NextResponse.json(
      { error: "Choose administrator or member." },
      { headers: noStore, status: 400 },
    );
  }

  try {
    const person = await setPersonRole(id, role);

    logSecurityEvent("info", {
      category: "people_role_changed",
      ipAddress,
      message: "An administrator changed an account's role.",
      metadata: { role, targetUserId: person.id },
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { people: await listPeople(), you: session.user.id },
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof PeopleError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "people_role_change_failure",
      ipAddress,
      message: "Unexpected failure while changing an account's role.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "That change could not be saved." },
      { headers: noStore, status: 500 },
    );
  }
}
