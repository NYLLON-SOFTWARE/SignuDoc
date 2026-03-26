import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { EnvelopeMutationError, voidSentEnvelope } from "@/lib/envelopes";
import { logRouteError } from "@/lib/security/logging";
import { applyRateLimit, buildRateLimitKey } from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";

type EnvelopeVoidRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(
  request: Request,
  context: EnvelopeVoidRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = applyRateLimit({
    category: "sent_envelope_void",
    key: buildRateLimitKey(["envelope-void", session.user.id, id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  try {
    const result = await voidSentEnvelope(
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
    if (error instanceof EnvelopeMutationError) {
      return NextResponse.json(
        { error: error.message },
        {
          headers: {
            "cache-control": "private, no-store",
          },
          status: error.statusCode,
        },
      );
    }

    logRouteError(error, {
      category: "sent_envelope_void_failure",
      ipAddress,
      message: "Unexpected failure while voiding an envelope.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to void this envelope." },
      {
        headers: {
          "cache-control": "private, no-store",
        },
        status: 500,
      },
    );
  }
}
