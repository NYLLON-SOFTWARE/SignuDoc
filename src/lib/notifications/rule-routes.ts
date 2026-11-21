import { NextResponse } from "next/server";

import { requireAdminSession } from "../auth/admin.ts";
import { logRouteError } from "../security/logging.ts";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "../security/route-controls.ts";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "../security/request.ts";
import { NotificationSettingsError, type NotificationRule } from "./rules.ts";
import type { NotificationSettingsActor } from "./store.ts";

// What the rule routes share: an administrator's session, a rate limit,
// and the answer, which is always the whole list of rules after the change.

export async function handleRuleChange(
  request: Request,
  change: (actor: NotificationSettingsActor) => Promise<NotificationRule[]>,
): Promise<Response> {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "notification_rules",
    key: buildRateLimitKey(["notification-rules", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const rules = await change({
      email: session.user.email,
      id: session.user.id,
      ipAddress: getClientIpAddress(request.headers),
      userAgent: getRequestUserAgent(request.headers),
    });

    return NextResponse.json({ rules });
  } catch (error) {
    if (error instanceof NotificationSettingsError) {
      return NextResponse.json(
        { error: error.message, fieldErrors: error.fieldErrors },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "notification_rule_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while changing a notification rule.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
