import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  Part11Error,
  setIdentityVerification,
  unlockSigning,
} from "@/lib/part11";
import { listPeople } from "@/lib/people";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";

type PersonRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const noStore = { "cache-control": "private, no-store" };

// Part 11 controls on one account: confirm who the person is ("verify",
// with a note saying how), take that back ("revoke"), or let them sign again
// after wrong passwords locked them ("unlock"). Administrators only.
// Answers with the list as it now stands, narrowed by the page's `search`.
export async function POST(request: Request, context: PersonRouteContext) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const rateLimitResponse = await applyRateLimit({
    category: "people_part11_change",
    key: buildRateLimitKey(["people-part11", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    note?: unknown;
    search?: unknown;
  } | null;
  const actor = {
    email: session.user.email,
    ipAddress: getClientIpAddress(request.headers),
    userAgent: getRequestUserAgent(request.headers),
    userId: session.user.id,
  };
  const search = typeof body?.search === "string" ? body.search : "";

  try {
    switch (body?.action) {
      case "verify":
      case "revoke":
        await setIdentityVerification(actor, id, {
          note: typeof body.note === "string" ? body.note : null,
          verified: body.action === "verify",
        });
        break;
      case "unlock":
        await unlockSigning(actor, id);
        break;
      default:
        return NextResponse.json(
          { error: "Choose verify, revoke or unlock." },
          { headers: noStore, status: 400 },
        );
    }

    return NextResponse.json(
      { ...(await listPeople({ search })), you: session.user.id },
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof Part11Error) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "people_part11_failure",
      ipAddress: actor.ipAddress,
      message: "Unexpected failure while changing an account's Part 11 status.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "That change could not be saved." },
      { headers: noStore, status: 500 },
    );
  }
}
