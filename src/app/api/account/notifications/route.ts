import { NextResponse } from "next/server";
import { z } from "zod";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { savePreferenceChoices } from "@/lib/notifications/preferences";
import {
  getNotificationPreferencesView,
  sendChannelTestMessage,
} from "@/lib/notifications/settings";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// A person's own notification choices: which events they get a direct
// message about, for the envelopes they sent. And a test
// message to themselves, to see that Slack finds them.

const actionSchema = z.object({ action: z.literal("test_slack_message") });

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "notification_preferences_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure in the notification preferences.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json({
      view: await getNotificationPreferencesView(session.user.id),
    });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function PUT(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const limited = await applyRateLimit({
    category: "notification_preferences",
    key: buildRateLimitKey(["notification-preferences", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const saved = await savePreferenceChoices(
      session.user.id,
      await request.json().catch(() => null),
    );

    if (!saved) {
      return NextResponse.json(
        { error: "Those choices could not be read." },
        { status: 400 },
      );
    }

    return NextResponse.json({
      view: await getNotificationPreferencesView(session.user.id),
    });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function POST(request: Request) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  // Each test is a message from the app, so only a few.
  const limited = await applyRateLimit({
    category: "notification_test_message",
    key: buildRateLimitKey(["notification-test", session.user.id]),
    limit: 5,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  if (!actionSchema.safeParse(await request.json().catch(() => null)).success) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  try {
    const view = await getNotificationPreferencesView(session.user.id);

    if (
      !view.channels.some(
        (channel) => channel.id === "slack" && channel.available,
      )
    ) {
      return NextResponse.json({
        result: {
          message: "Direct messages from Slack are not set up on this site.",
          ok: false,
        },
      });
    }

    return NextResponse.json({
      result: await sendChannelTestMessage("slack", {
        email: session.user.email,
      }),
    });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
