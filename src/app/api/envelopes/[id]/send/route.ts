import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { EnvelopeMutationError, sendDraftEnvelope } from "@/lib/envelopes";
import { sendEnvelopeOptionsSchema } from "@/lib/schemas/envelope";
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

type EnvelopeSendRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type SendEnvelopeRequest = {
  expiresInDays?: unknown;
  permittedUseConfirmed?: boolean;
};

export async function POST(
  request: Request,
  context: EnvelopeSendRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = await applyRateLimit({
    category: "draft_envelope_send",
    key: buildRateLimitKey(["envelope-send", session.user.id]),
    limit: 10,
    request,
    userId: session.user.id,
    windowMs: 60 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  const body = (await request
    .json()
    .catch(() => null)) as SendEnvelopeRequest | null;

  if (body?.permittedUseConfirmed !== true) {
    return NextResponse.json(
      {
        error:
          "Confirm that this envelope is an ordinary business agreement before sending.",
      },
      { status: 400 },
    );
  }

  const options = sendEnvelopeOptionsSchema.safeParse({
    expiresInDays: body.expiresInDays ?? undefined,
  });

  if (!options.success) {
    return NextResponse.json(
      { error: "Choose a deadline between 1 and 365 days from now." },
      { status: 400 },
    );
  }

  try {
    const result = await sendDraftEnvelope(
      session.user.id,
      id,
      {
        expiresInDays: options.data.expiresInDays,
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

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof EnvelopeMutationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "draft_envelope_send_failure",
      ipAddress,
      message: "Unexpected failure while sending an envelope.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to send this envelope." },
      { status: 500 },
    );
  }
}
