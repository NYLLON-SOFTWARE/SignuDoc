import { APIError } from "better-auth";
import { NextResponse } from "next/server";

import { getAuth, getAuthSessionFromHeaders } from "@/lib/auth/server";
import { runAsSetup } from "@/lib/auth/setup-context";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { completeSetup, SetupError } from "@/lib/setup";

// First-run setup. Open to anyone who reaches it while the install has no
// administrator, which is the point: there is nobody to sign in as yet.
// What keeps it safe is in completeSetup (one winner, and SETUP_TOKEN when
// the deployment sets one), a rate limit, and the JSON-only rule below.

function isJsonRequest(request: Request): boolean {
  return (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/json");
}

async function createAdminAccount(input: {
  email: string;
  name: string;
  password: string;
}) {
  try {
    const result = await runAsSetup(() =>
      getAuth().api.signUpEmail({
        body: {
          email: input.email,
          name: input.name,
          password: input.password,
        },
      }),
    );

    return { userId: result.user.id };
  } catch (error) {
    if (error instanceof APIError) {
      const code = String(error.body?.code ?? "");
      const message =
        error.body?.message ?? "The account could not be created.";

      if (code === "PASSWORD_COMPROMISED") {
        throw new SetupError("Choose a different password.", 400, {
          password: "This password has appeared in a breach. Choose another.",
        });
      }

      throw new SetupError(message, 400);
    }

    throw error;
  }
}

export async function POST(request: Request) {
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = applyRateLimit({
    category: "setup_submit",
    key: buildRateLimitKey(["setup", ipAddress ?? "unknown"]),
    limit: 10,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  // A page on another site can make a browser send a form here, but it
  // cannot make it send JSON without this site's permission. Insisting on
  // JSON keeps a stranger's page from running setup in a visitor's browser.
  if (!isJsonRequest(request)) {
    return NextResponse.json(
      { error: "Send this request as JSON." },
      { status: 415 },
    );
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  try {
    const session = await getAuthSessionFromHeaders(request.headers);
    const result = await completeSetup(body ?? {}, {
      createAdminAccount,
      sessionUser: session
        ? {
            email: session.user.email,
            emailVerified: session.user.emailVerified === true,
            id: session.user.id,
          }
        : null,
    });

    logSecurityEvent("info", {
      category: "setup_completed",
      ipAddress,
      message: `First-run setup completed (${result.mode}).`,
      path: getRequestPathname(request),
      userId: result.userId,
    });

    if (result.mode === "create") {
      // Sign the new administrator in, so setup ends inside the app rather
      // than at a sign-in form. If this fails the account still exists and
      // they can sign in by hand.
      try {
        await getAuth().api.signInEmail({
          body: {
            email: result.email,
            password: String(body?.password ?? ""),
          },
          headers: request.headers,
        });
      } catch (error) {
        console.error(
          "Setup finished, but signing in afterwards failed:",
          error,
        );

        return NextResponse.json({ redirectTo: "/login" }, { status: 201 });
      }
    }

    return NextResponse.json(
      { redirectTo: "/settings#organization" },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof SetupError) {
      if (error.statusCode === 403) {
        logSecurityEvent("warn", {
          category: "setup_refused",
          ipAddress,
          message: error.message,
          path: getRequestPathname(request),
        });
      }

      return NextResponse.json(
        { error: error.message, fieldErrors: error.fieldErrors },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "setup_failure",
      ipAddress,
      message: "Unexpected failure during first-run setup.",
      path: getRequestPathname(request),
    });

    return NextResponse.json(
      { error: "Setup could not be completed. Please try again." },
      { status: 500 },
    );
  }
}
