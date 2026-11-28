import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireEnvelopeOwnerSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { copyEnvelopeToDraft, EnvelopeMutationError } from "@/lib/envelopes";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { TeamError } from "@/lib/teams";

type EnvelopeCopyRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const noStore = { "cache-control": "private, no-store" };

// Starts a new draft from an envelope that has already gone out. Nothing
// is emailed, and the original is left as it is.

export async function POST(
  request: Request,
  context: EnvelopeCopyRouteContext,
) {
  const { id } = await context.params;
  const sessionResult = await requireEnvelopeOwnerSession(request, id);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const ipAddress = getClientIpAddress(request.headers);
  // The same allowance as uploading a document or using a template: each
  // makes a draft and stores a copy of the PDF, so a per-envelope limit
  // would let one account fill storage by copying many envelopes.
  const rateLimitResponse = await applyRateLimit({
    category: "draft_envelope_create",
    key: buildRateLimitKey(["draft-create", session.user.id]),
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
    const result = await copyEnvelopeToDraft(session.user.id, id, {
      actorEmail: session.user.email,
      database: getDb(),
    });

    return NextResponse.json(result, { headers: noStore, status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid copy request." },
        { headers: noStore, status: 400 },
      );
    }

    if (error instanceof EnvelopeMutationError || error instanceof TeamError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "envelope_copy_failure",
      ipAddress,
      message: "Unexpected failure while copying an envelope to a draft.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to copy this envelope." },
      { headers: noStore, status: 500 },
    );
  }
}
