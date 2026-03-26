import { NextResponse } from "next/server";

import { getAuthSessionFromHeaders } from "./server.ts";
import { logSecurityEvent } from "../security/logging.ts";
import {
  getClientIpAddress,
  getRequestPathname,
} from "../security/request.ts";

export async function requireVerifiedSenderSession(request: Request) {
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (session.user.emailVerified === true) {
    return session;
  }

  logSecurityEvent("warn", {
    category: "email_verification_required",
    ipAddress: getClientIpAddress(request.headers),
    message: "Blocked an authenticated sender action for an unverified user.",
    path: getRequestPathname(request),
    userId: session.user.id,
  });

  return NextResponse.json(
    {
      error: "Verify your email address before continuing.",
    },
    { status: 403 },
  );
}
