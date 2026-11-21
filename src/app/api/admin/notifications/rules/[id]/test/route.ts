import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { sendRuleTest } from "@/lib/notifications/settings";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

type RuleTestRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// A rule's "Send test": posts a sample of the rule's first event to its
// channel and says, in plain words, whether Slack took it. Administrators
// only.
export async function POST(request: Request, context: RuleTestRouteContext) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "notification_settings",
    key: buildRateLimitKey(["notification-rule-test", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const { id } = await context.params;

  try {
    const result = await sendRuleTest(id);

    if (!result) {
      return NextResponse.json(
        { error: "That rule no longer exists." },
        { status: 404 },
      );
    }

    return NextResponse.json({ result });
  } catch (error) {
    logRouteError(error, {
      category: "notification_settings_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while testing a notification rule.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
