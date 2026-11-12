import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { saveEnvelopeAsTemplate, TemplateError } from "@/lib/templates";

type EnvelopeTemplateRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// Keeps this envelope's document, fields and signing order as a template.

export async function POST(
  request: Request,
  context: EnvelopeTemplateRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "template_save",
    key: buildRateLimitKey(["template-save", session.user.id]),
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
    const template = await saveEnvelopeAsTemplate(session.user.id, id, body, {
      database: getDb(),
    });

    return NextResponse.json(
      { name: template.name, templateId: template.id },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid template request." },
        { status: 400 },
      );
    }

    if (error instanceof TemplateError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "template_save_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while saving an envelope as a template.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to save this as a template." },
      { status: 500 },
    );
  }
}
