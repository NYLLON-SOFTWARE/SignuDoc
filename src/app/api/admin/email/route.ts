import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  addEmailDomain,
  getEmailStatus,
  recheckEmailDomain,
} from "@/lib/email-status";
import { sendTestEmail } from "@/lib/email-test";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// Email setup for the Organization tab in Settings: whether email works,
// and the steps an administrator can take from the app when it does not.

const actionSchema = z.object({
  action: z.enum(["add_domain", "recheck", "send_test"]),
});

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "email_setup_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure while checking email setup.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Email setup could not be checked. Please try again." },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  try {
    return NextResponse.json({ status: await getEmailStatus() });
  } catch (error) {
    return failure(request, error, sessionResult.user.id);
  }
}

export async function POST(request: Request) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "email_setup_action",
    key: buildRateLimitKey(["email-setup", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  try {
    if (parsed.data.action === "send_test") {
      const result = await sendTestEmail({
        name: session.user.name,
        to: session.user.email,
      });

      return NextResponse.json(
        { status: await getEmailStatus(), test: result },
        { status: result.sent ? 200 : 502 },
      );
    }

    const status =
      parsed.data.action === "add_domain"
        ? await addEmailDomain()
        : await recheckEmailDomain();

    return NextResponse.json({ status });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
