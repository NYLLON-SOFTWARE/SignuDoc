import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { Part11Error, setPart11Mode } from "@/lib/part11";
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
import { getSettings } from "@/lib/settings";

const noStore = { "cache-control": "private, no-store" };

// Turns Part 11 mode on or off. Administrators only.
export async function PUT(request: Request) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "part11_mode_change",
    key: buildRateLimitKey(["part11-mode", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const body = (await request.json().catch(() => null)) as {
    enabled?: unknown;
  } | null;

  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json(
      { error: "Say whether Part 11 mode should be on." },
      { headers: noStore, status: 400 },
    );
  }

  if ((await getSettings()).hosted) {
    return NextResponse.json(
      { error: "Part 11 mode is for self-hosted installs." },
      { headers: noStore, status: 400 },
    );
  }

  try {
    await setPart11Mode(
      {
        email: session.user.email,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
        userId: session.user.id,
      },
      body.enabled,
    );

    return NextResponse.json(
      { part11Mode: (await getSettings()).part11Mode },
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
      category: "part11_mode_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while changing Part 11 mode.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "That change could not be saved." },
      { headers: noStore, status: 500 },
    );
  }
}
