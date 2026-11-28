import { NextResponse } from "next/server";

import { getAuthSessionFromHeaders } from "./server.ts";
import { resolveEnvelopeViewerAccess } from "../envelope-access.ts";
import { logSecurityEvent } from "../security/logging.ts";
import { getSettings } from "../settings.ts";
import { needsTwoFactorSetup } from "../sign-in-security.ts";
import { getClientIpAddress, getRequestPathname } from "../security/request.ts";

export async function requireVerifiedSenderSession(request: Request) {
  const session = await getAuthSessionFromHeaders(request.headers);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (session.user.emailVerified === true) {
    if (await needsTwoFactorSetup(await getSettings(), session.user)) {
      return NextResponse.json(
        { error: "Set up two-step sign-in before continuing." },
        { status: 403 },
      );
    }

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

export async function requireEnvelopeOwnerSession(
  request: Request,
  envelopeId: string,
) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const access = await resolveEnvelopeViewerAccess(session.user.id, envelopeId);

  return access?.viewerIsOwner
    ? session
    : NextResponse.json({ error: "Envelope not found." }, { status: 404 });
}
