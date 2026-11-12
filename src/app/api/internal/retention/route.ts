import { NextResponse } from "next/server";

import {
  identifyRetentionCaller,
  isCronLockedOutByOlderSecret,
  retentionJobFailed,
  runRetentionJob,
} from "@/lib/retention-job";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// The daily job: the cleanup, then expiry notices for envelopes whose
// deadline passed. Vercel's cron job calls this with GET (see vercel.json);
// a scheduler elsewhere can use POST as before.
//
// With a job secret configured, only a caller that presents it gets in, and
// it gets the summary back. With none, anyone may call and gets an empty
// answer whether or not anything ran: see src/lib/retention-job.ts for why
// that is safe to leave open.

async function handle(request: Request) {
  const caller = identifyRetentionCaller(request.headers.get("authorization"));

  if (caller === "denied") {
    if (isCronLockedOutByOlderSecret(request.headers.get("user-agent"))) {
      console.warn(
        "[retention] Vercel's daily cleanup call was refused: RETENTION_JOB_SECRET is set, and Vercel only sends CRON_SECRET. Store the secret as CRON_SECRET instead, or remove it.",
      );
    }

    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const outcome = await runRetentionJob({ caller });
    const failed = outcome.status === "ran" && retentionJobFailed(outcome);

    if (caller === "authorized") {
      return NextResponse.json(
        outcome.status === "ran"
          ? { ...outcome.summary, schedule: outcome.schedule }
          : outcome,
        { status: failed ? 500 : 200 },
      );
    }

    return new NextResponse(null, { status: failed ? 500 : 204 });
  } catch (error) {
    logRouteError(error, {
      category: "retention_job_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "The cleanup job failed.",
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
