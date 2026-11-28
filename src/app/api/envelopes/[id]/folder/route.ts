import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth/admin";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { folderIdSchema } from "@/lib/schemas/common";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { moveEnvelopeToFolder, TeamError } from "@/lib/teams";
import { readLimitedBody } from "@/lib/utils/limited-body";

const moveSchema = z.object({ folderId: folderIdSchema });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminSession(request);
  if (session instanceof Response) {
    return session;
  }
  const limited = await applyRateLimit({
    category: "team_change",
    key: buildRateLimitKey(["team-change", session.user.id]),
    limit: 120,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const body = await readLimitedBody(request, 1024)
    .then((bytes) => bytes && JSON.parse(new TextDecoder().decode(bytes)))
    .catch(() => null);
  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Choose a folder." }, { status: 400 });
  }
  const { id } = await params;
  const ipAddress = getClientIpAddress(request.headers);
  try {
    await moveEnvelopeToFolder(
      {
        email: session.user.email,
        userId: session.user.id,
        ipAddress,
        userAgent: request.headers.get("user-agent"),
      },
      id,
      parsed.data.folderId,
    );
    return NextResponse.json({ folderId: parsed.data.folderId });
  } catch (error) {
    if (error instanceof TeamError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    logRouteError(error, {
      category: "envelope_move_failure",
      ipAddress,
      message: "Unexpected failure while moving an agreement.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Unable to move the agreement." },
      { status: 500 },
    );
  }
}
