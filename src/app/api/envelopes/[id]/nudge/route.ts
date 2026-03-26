import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  ReminderMutationError,
  sendManualEnvelopeNudge,
} from "@/lib/reminders";
import { logRouteError } from "@/lib/security/logging";
import { applyRateLimit, buildRateLimitKey } from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";

type EnvelopeNudgeRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(
  request: Request,
  context: EnvelopeNudgeRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = applyRateLimit({
    category: "envelope_nudge",
    key: buildRateLimitKey(["envelope-nudge", session.user.id, id]),
    limit: 5,
    request,
    userId: session.user.id,
    windowMs: 60 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  try {
    const result = await sendManualEnvelopeNudge(
      session.user.id,
      id,
      {
        ipAddress,
        senderEmail: session.user.email,
        senderName:
          typeof session.user.name === "string" && session.user.name.trim()
            ? session.user.name
            : session.user.email,
        userAgent: getRequestUserAgent(request.headers),
      },
      {
        database: getDb(),
      },
    );

    return NextResponse.json(result, {
      headers: {
        "cache-control": "private, no-store",
      },
      status: 200,
    });
  } catch (error) {
    if (error instanceof ReminderMutationError) {
      return NextResponse.json(
        {
          error: error.message,
          nextAvailableAt: error.nextAvailableAt,
          nextAvailableAtLabel: error.nextAvailableAtLabel,
        },
        {
          headers: {
            "cache-control": "private, no-store",
          },
          status: error.statusCode,
        },
      );
    }

    logRouteError(error, {
      category: "envelope_nudge_failure",
      ipAddress,
      message: "Unexpected failure while sending an envelope reminder.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to send a reminder." },
      {
        headers: {
          "cache-control": "private, no-store",
        },
        status: 500,
      },
    );
  }
}
