import { NextResponse } from "next/server";

import { runNotificationJob } from "@/lib/notifications/job";
import { identifyRetentionCaller } from "@/lib/retention-job";
import { logRouteError } from "@/lib/security/logging";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// The notifications job (src/lib/notifications/job.ts): notices deadlines
// coming up and envelopes with no activity, and sends whatever is due,
// retries included. Most messages go out right after the event without it
// (notifications/kick.ts); this catches up on the rest.
// On Vercel the cron job in vercel.json calls it once a day; elsewhere a
// scheduler of the deployer's own can call it as often as every few
// minutes.
//
// Callers are trusted the same way as the daily cleanup's: with CRON_SECRET
// or RETENTION_JOB_SECRET set, only a caller with it gets in. Without one,
// anyone may call, at most once a minute whoever asks, and gets an empty
// answer.

export const maxDuration = 120;

const ANONYMOUS_RUN_INTERVAL_MS = 60 * 1000;
const RUN_BUDGET_MS = 90_000;

async function handle(request: Request) {
  const startedAt = Date.now();
  const caller = identifyRetentionCaller(request.headers.get("authorization"));

  if (caller === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (caller === "anonymous") {
    const ration = await consumeRateLimit({
      key: "job:notifications",
      limit: 1,
      windowMs: ANONYMOUS_RUN_INTERVAL_MS,
    });

    if (!ration.allowed) {
      return new NextResponse(null, { status: 204 });
    }
  }

  try {
    const summary = await runNotificationJob({
      deadline: startedAt + RUN_BUDGET_MS,
    });

    return caller === "authorized"
      ? NextResponse.json(summary)
      : new NextResponse(null, { status: 204 });
  } catch (error) {
    logRouteError(error, {
      category: "notification_job_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "The notifications job failed.",
      path: getRequestPathname(request),
    });

    return new NextResponse(null, { status: 500 });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
