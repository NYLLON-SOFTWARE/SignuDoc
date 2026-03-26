import { NextResponse } from "next/server";

import { runRetentionSweep } from "@/lib/retention";
import { getEnv } from "@/lib/utils/env";

function isAuthorizedRequest(request: Request, secret: string) {
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  const retentionJobSecret = getEnv().internal.retentionJobSecret;

  if (!retentionJobSecret) {
    return NextResponse.json(
      {
        error: "Retention job secret is not configured.",
      },
      { status: 503 },
    );
  }

  if (!isAuthorizedRequest(request, retentionJobSecret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const summary = await runRetentionSweep();
  const hasFailures =
    summary.accountPurgeFailures.length > 0 ||
    summary.draftDeletionFailures.length > 0;

  return NextResponse.json(summary, {
    status: hasFailures ? 500 : 200,
  });
}
