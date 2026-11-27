import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { frameAncestorsFor } from "@/lib/embed-origin";
import { supportsDirectUploads } from "@/lib/services/storage/driver";

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

// With Vercel Blob the upload page sends the PDF straight to the Blob API,
// so the browser must be allowed to connect to it. The address is the one
// the Blob SDK uses, including its override for a stand-in API.
// https://vercel.com/docs/vercel-blob/vercel-signed-urls#presigned-uploads
const DEFAULT_BLOB_API_URL = "https://vercel.com/api/blob";

function resolveBlobUploadSource() {
  try {
    if (!supportsDirectUploads()) {
      return false;
    }
  } catch {
    return false;
  }

  const apiUrl =
    process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL?.trim() || DEFAULT_BLOB_API_URL;

  // The trailing slash limits the allowance to this path and below.
  return `${apiUrl.replace(/\/+$/, "")}/`;
}

/**
 * A fresh value for each request. Next.js reads it from the policy on the
 * request and puts it on the scripts it writes into the page, so they run
 * and a script that found its way into the page some other way does not.
 * https://nextjs.org/docs/app/guides/content-security-policy
 */
function createNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function buildContentSecurityPolicy(frameAncestors: string, nonce: string) {
  const preview = isVercelPreview();
  const botProtection = process.env.NEXT_PUBLIC_BOTID === "1";
  const directives: Array<[name: string, sources: Array<string | false>]> = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["frame-ancestors", [frameAncestors]],
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
        resolveBlobUploadSource(),
        preview && "https://vercel.live wss://ws-us3.pusher.com",
      ],
    ],
    [
      "frame-src",
      [
        preview && "https://vercel.live",
        // BotID's deeper check runs in a hidden frame on this same site.
        // Not yet confirmed against a live deployment; see the note on
        // BotID in docs/self-hosting.md.
        botProtection && "'self'",
        !preview && !botProtection && "'none'",
      ],
    ],
    ["worker-src", ["'self'", "blob:"]],
    // Styles keep 'unsafe-inline': React writes style attributes, which a
    // nonce cannot cover, and a nonce here would turn 'unsafe-inline' off.
    [
      "style-src",
      ["'self'", "'unsafe-inline'", preview && "https://vercel.live"],
    ],
    // Scripts from this site, and inline ones only with this request's
    // nonce. No 'strict-dynamic', so the hosts listed for previews still
    // count, and the scripts Next.js and BotID load are from 'self'.
    [
      "script-src",
      [
        "'self'",
        `'nonce-${nonce}'`,
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

function applySecurityHeaders(
  response: NextResponse,
  pathname: string,
  policy: { contentSecurityPolicy: string; frameAncestors: string },
) {
  response.headers.set("Content-Security-Policy", policy.contentSecurityPolicy);
  response.headers.set("Permissions-Policy", DEFAULT_PERMISSIONS_POLICY);
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");

  if (policy.frameAncestors === "'none'") {
    response.headers.set("X-Frame-Options", "DENY");
  }

  if (isProductionEnvironment()) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  if (
    !pathname.startsWith("/sign/") &&
    !pathname.startsWith("/embed/sign/") &&
    !pathname.startsWith("/api/signing/") &&
    !pathname.startsWith("/api/download/") &&
    !pathname.startsWith("/download/")
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

// The sign-in and sign-up pages send someone already signed in on to their
// documents themselves (redirectIfSignedIn), after asking the auth server.
// This proxy does not: the cookie cache can still vouch for a session for a
// few minutes after it was ended or passed the install's session limits,
// and trusting it here would bounce that visitor between /login and
// /dashboard until it ran out.

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // Only an embedded signing page may be framed, and only by the site its
  // link names (see src/lib/embed-origin.ts). Everything else, never.
  const frameAncestors = frameAncestorsFor(
    pathname,
    request.nextUrl.searchParams,
  );
  const contentSecurityPolicy = buildContentSecurityPolicy(
    frameAncestors,
    createNonce(),
  );

  // The policy goes on the request too: that is where Next.js finds the
  // nonce while it renders the page.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  return applySecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    pathname,
    { contentSecurityPolicy, frameAncestors },
  );
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
