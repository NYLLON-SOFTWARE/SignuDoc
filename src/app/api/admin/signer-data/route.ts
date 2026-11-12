import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  SignerDataError,
  eraseSignerData,
  exportSignerData,
} from "@/lib/signer-data";

// Signer data requests (access, portability, erasure). Administrators only.

async function guard(request: Request, action: "erase" | "export") {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return { response: sessionResult };
  }

  const rateLimitResponse = await applyRateLimit({
    category: `signer_data_${action}`,
    key: buildRateLimitKey(["signer-data", action, sessionResult.user.id]),
    limit: action === "erase" ? 10 : 30,
    request,
    userId: sessionResult.user.id,
    windowMs: 10 * 60 * 1000,
  });

  return rateLimitResponse
    ? { response: rateLimitResponse }
    : { response: null };
}

function errorResponse(error: unknown, request: Request) {
  if (error instanceof SignerDataError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.statusCode },
    );
  }

  logRouteError(error, {
    category: "signer_data_failure",
    message: "Unexpected failure while handling a signer data request.",
    path: request.url,
  });

  return NextResponse.json(
    { error: "That request could not be completed." },
    { status: 500 },
  );
}

/** GET ?email=...: a JSON file of everything stored about that signer. */
export async function GET(request: Request) {
  const { response } = await guard(request, "export");

  if (response) {
    return response;
  }

  try {
    const data = await exportSignerData(
      new URL(request.url).searchParams.get("email"),
    );

    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="signer-data.json"`,
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return errorResponse(error, request);
  }
}

/** DELETE {email, confirmation}: erases that signer's records. */
export async function DELETE(request: Request) {
  const { response } = await guard(request, "erase");

  if (response) {
    return response;
  }

  const body = (await request.json().catch(() => null)) as {
    confirmation?: unknown;
    email?: unknown;
  } | null;

  try {
    return NextResponse.json(
      await eraseSignerData(body?.email, body?.confirmation),
    );
  } catch (error) {
    return errorResponse(error, request);
  }
}
