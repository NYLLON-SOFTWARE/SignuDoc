import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import {
  buildCreateEnvelopeResponse,
  createDraftEnvelope,
} from "@/lib/envelopes";
import { getDb } from "@/lib/db/connection";
import { envelopeTitleSchema } from "@/lib/schemas/common";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { DocumentImportError } from "@/lib/services/document-import";

export async function POST(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = applyRateLimit({
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

  const formData = await request.formData().catch(() => null);
  const parsedTitle = envelopeTitleSchema.safeParse(formData?.get("title"));
  const uploadedFile = formData?.get("file");

  if (!parsedTitle.success) {
    const issue = parsedTitle.error.issues[0];

    return NextResponse.json(
      { error: issue?.message ?? "Invalid envelope request." },
      { status: 400 },
    );
  }

  if (!(uploadedFile instanceof File)) {
    return NextResponse.json(
      { error: "A PDF file is required." },
      { status: 400 },
    );
  }

  try {
    const sourcePdfBody = new Uint8Array(await uploadedFile.arrayBuffer());
    const result = await createDraftEnvelope(
      session.user.id,
      {
        sourcePdf: {
          body: sourcePdfBody,
          contentType: uploadedFile.type,
          filename: uploadedFile.name,
        },
        title: parsedTitle.data,
      },
      {
        database: getDb(),
      },
    );

    return NextResponse.json(buildCreateEnvelopeResponse(result), {
      status: 201,
    });
  } catch (error) {
    if (error instanceof DocumentImportError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logRouteError(error, {
      category: "draft_envelope_create_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while creating a draft envelope.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to create the draft envelope." },
      { status: 500 },
    );
  }
}
