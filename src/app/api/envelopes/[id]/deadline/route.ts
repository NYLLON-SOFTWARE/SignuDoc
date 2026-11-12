import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { changeEnvelopeDeadline, EnvelopeMutationError } from "@/lib/envelopes";
import { changeDeadlineSchema } from "@/lib/schemas/envelope";
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

type EnvelopeDeadlineRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const noStore = { "cache-control": "private, no-store" };

// Gives an envelope that is out for signature a new deadline, counted in
// days from now. Works on an expired one too, which is how it is revived.
export async function POST(
  request: Request,
  context: EnvelopeDeadlineRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = await applyRateLimit({
    category: "envelope_deadline",
    key: buildRateLimitKey(["envelope-deadline", session.user.id, id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 60 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  const parsed = changeDeadlineSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose a deadline between 1 and 365 days from now." },
      { headers: noStore, status: 400 },
    );
  }

  try {
    const result = await changeEnvelopeDeadline(
      session.user.id,
      id,
      {
        expiresInDays: parsed.data.expiresInDays,
        ipAddress,
        senderEmail: session.user.email,
        userAgent: getRequestUserAgent(request.headers),
      },
      { database: getDb() },
    );

    return NextResponse.json(result, { headers: noStore, status: 200 });
  } catch (error) {
    if (error instanceof EnvelopeMutationError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "envelope_deadline_failure",
      ipAddress,
      message: "Unexpected failure while changing an envelope deadline.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to change the deadline." },
      { headers: noStore, status: 500 },
    );
  }
}
