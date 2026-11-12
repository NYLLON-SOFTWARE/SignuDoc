import type { NextRequest } from "next/server";
import { getCookieCache, getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";

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

function buildContentSecurityPolicy() {
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    ...(isProductionEnvironment() ? [] : ["'unsafe-eval'"]),
  ].join(" ");
  const r2ConnectSource = "https://*.r2.cloudflarestorage.com";

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${r2ConnectSource}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptSrc}`,
  ].join("; ");
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
  if (process.env.BETTER_AUTH_SECRET) {
    try {
      const session = await getCookieCache(request, {
        secret: process.env.BETTER_AUTH_SECRET,
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
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const requestProtocol =
    forwardedProto ?? request.nextUrl.protocol.replace(":", "");
  const isLocalHostname =
    request.nextUrl.hostname === "localhost" ||
    request.nextUrl.hostname === "127.0.0.1" ||
    request.nextUrl.hostname === "::1";

  if (
    isProductionEnvironment() &&
    !isLocalHostname &&
    requestProtocol !== "https"
  ) {
    const httpsUrl = request.nextUrl.clone();

    httpsUrl.protocol = "https:";

    return applySecurityHeaders(NextResponse.redirect(httpsUrl), pathname);
  }

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
