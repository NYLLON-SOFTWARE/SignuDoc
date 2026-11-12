import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { EnvelopeMutationError } from "@/lib/envelopes";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { DocumentImportError } from "@/lib/services/document-import";
import { createDraftFromTemplate, TemplateError } from "@/lib/templates";

type UseTemplateRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// Starts a draft envelope from a template.

export async function POST(request: Request, context: UseTemplateRouteContext) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  // The same allowance as uploading a document: either way a draft is made.
  const rateLimitResponse = await applyRateLimit({
    category: "draft_envelope_create",
    key: buildRateLimitKey(["draft-create", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as unknown;

  try {
    const draft = await createDraftFromTemplate(session.user.id, id, body, {
      database: getDb(),
    });

    return NextResponse.json(draft, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid template request." },
        { status: 400 },
      );
    }

    if (
      error instanceof TemplateError ||
      error instanceof EnvelopeMutationError
    ) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    if (error instanceof DocumentImportError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logRouteError(error, {
      category: "template_use_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while starting a draft from a template.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to start an envelope from this template." },
      { status: 500 },
    );
  }
}
