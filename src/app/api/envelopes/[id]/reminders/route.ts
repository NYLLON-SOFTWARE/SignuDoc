import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  changeEnvelopeReminders,
  EnvelopeMutationError,
} from "@/lib/envelopes";
import { changeRemindersSchema } from "@/lib/schemas/envelope";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

type EnvelopeRemindersRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const noStore = { "cache-control": "private, no-store" };

// Turns automatic reminders on, off, or to another interval for an envelope
// that is out for signature. The daily job sends them.
export async function POST(
  request: Request,
  context: EnvelopeRemindersRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = await applyRateLimit({
    category: "envelope_reminders",
    key: buildRateLimitKey(["envelope-reminders", session.user.id, id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 60 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  const parsed = changeRemindersSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Choose reminders between 1 and 30 days apart, or turn them off.",
      },
      { headers: noStore, status: 400 },
    );
  }

  try {
    const result = await changeEnvelopeReminders(
      session.user.id,
      id,
      parsed.data.reminderIntervalDays,
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
      category: "envelope_reminders_failure",
      ipAddress,
      message: "Unexpected failure while changing an envelope's reminders.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to change the reminders." },
      { headers: noStore, status: 500 },
    );
  }
}
