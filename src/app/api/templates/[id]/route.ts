import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { invitationCopySchema } from "@/lib/schemas/invitation";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  deleteTemplate,
  TemplateError,
  updateTemplateInvitation,
} from "@/lib/templates";

type TemplateRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function PATCH(request: Request, context: TemplateRouteContext) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const input = invitationCopySchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!input.success) {
    return NextResponse.json(
      {
        error:
          "Use a single-line subject of up to 160 characters and a message of up to 2,000 characters.",
      },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  try {
    await updateTemplateInvitation(session.user.id, id, input.data);
    return NextResponse.json({ updatedTemplateId: id });
  } catch (error) {
    if (error instanceof TemplateError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "template_invitation_update_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while updating a template invitation.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to save the template invitation." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, context: TemplateRouteContext) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;

  try {
    await deleteTemplate(session.user.id, id, { database: getDb() });

    return NextResponse.json({ deletedTemplateId: id }, { status: 200 });
  } catch (error) {
    if (error instanceof TemplateError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "template_delete_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while deleting a template.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to delete this template." },
      { status: 500 },
    );
  }
}
