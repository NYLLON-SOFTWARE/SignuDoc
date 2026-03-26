import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  EnvelopeMutationError,
  replaceDraftEnvelopeFields,
} from "@/lib/envelopes";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

type EnvelopeFieldsRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function PUT(
  request: Request,
  context: EnvelopeFieldsRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as unknown;

  try {
    const result = await replaceDraftEnvelopeFields(
      session.user.id,
      id,
      body,
      getDb(),
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];

      return NextResponse.json(
        { error: issue?.message ?? "Invalid field update request." },
        { status: 400 },
      );
    }

    if (error instanceof EnvelopeMutationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "draft_envelope_fields_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while updating draft fields.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to update this draft field list." },
      { status: 500 },
    );
  }
}
