import type { NextRequest } from "next/server";
import { getCookieCache, getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";

import { resolveAuthSecret, resolveAuthUrl } from "@/lib/utils/env";

const DEFAULT_PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "microphone=()",
  "payment=()",
  "publickey-credentials-get=()",
  "serial=()",
  "usb=()",
].join(", ");

function isProductionEnvironment() {
  return process.env.NODE_ENV === "production";
}

// The comments toolbar that Vercel adds to preview deployments loads from
// these hosts. They are allowed on previews only, never in production.
// https://vercel.com/docs/vercel-toolbar/managing-toolbar
function isVercelPreview() {
  return process.env.VERCEL === "1" && process.env.VERCEL_ENV === "preview";
}

function buildContentSecurityPolicy() {
  const preview = isVercelPreview();
  const directives: Array<[name: string, sources: Array<string | false>]> = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    ["object-src", ["'none'"]],
    [
      "img-src",
      [
        "'self'",
        "data:",
        "blob:",
        preview && "https://vercel.live https://vercel.com",
      ],
    ],
    [
      "font-src",
      [
        "'self'",
        "data:",
        preview && "https://vercel.live https://assets.vercel.com",
      ],
    ],
    [
      "connect-src",
      [
        "'self'",
        // The field editor reads the just-uploaded PDF back from a blob: URL.
        "blob:",
        preview && "https://vercel.live wss://ws-us3.pusher.com",
      ],
    ],
    ["frame-src", [preview ? "https://vercel.live" : "'none'"]],
    ["worker-src", ["'self'", "blob:"]],
    [
      "style-src",
      ["'self'", "'unsafe-inline'", preview && "https://vercel.live"],
    ],
    [
      "script-src",
      [
        "'self'",
        "'unsafe-inline'",
        !isProductionEnvironment() && "'unsafe-eval'",
        preview && "https://vercel.live",
      ],
    ],
  ];

  return directives
    .map(
      ([name, sources]) =>
        `${name} ${sources.filter((source) => source !== false).join(" ")}`,
    )
    .join("; ");
}

function applySecurityHeaders(response: NextResponse, pathname: string) {
  response.headers.set("Content-Security-Policy", buildContentSecurityPolicy());
  response.headers.set("Permissions-Policy", DEFAULT_PERMISSIONS_POLICY);
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");

  if (isProductionEnvironment()) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  if (
    !pathname.startsWith("/sign/") &&
    !pathname.startsWith("/api/signing/") &&
    !pathname.startsWith("/api/download/")
  ) {
    return response;
  }

  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");

  if (!response.headers.has("Cache-Control")) {
    response.headers.set("Cache-Control", "private, no-store");
  }

  return response;
}

async function hasOptimisticSession(request: NextRequest) {
  // Resolved the same way the auth server does, so this keeps working when
  // the secret is derived rather than set.
  const secret = resolveAuthSecret();

  if (secret) {
    try {
      const session = await getCookieCache(request, {
        isSecure: resolveAuthUrl()?.startsWith("https://") ?? false,
        secret,
      });

      if (session) {
        return true;
      }
    } catch {
      // Fall back to the session token check if cookie-cache parsing fails.
    }
  }

  return getSessionCookie(request) !== null;
}

async function maybeRedirectAuthenticatedAuthRoute(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname !== "/login" && pathname !== "/signup") {
    return null;
  }

  if (pathname === "/login") {
    const hasResetState =
      request.nextUrl.searchParams.has("token") ||
      request.nextUrl.searchParams.has("error");

    if (hasResetState) {
      return null;
    }
  }

  const hasSession = await hasOptimisticSession(request);

  if (!hasSession) {
    return null;
  }

  const dashboardUrl = request.nextUrl.clone();

  dashboardUrl.pathname = "/dashboard";
  dashboardUrl.search = "";

  return NextResponse.redirect(dashboardUrl);
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const authRedirect = await maybeRedirectAuthenticatedAuthRoute(request);

  if (authRedirect) {
    return applySecurityHeaders(authRedirect, pathname);
  }

  return applySecurityHeaders(NextResponse.next(), pathname);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
