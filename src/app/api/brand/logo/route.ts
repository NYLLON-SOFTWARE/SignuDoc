import { readBrandLogo } from "@/lib/brand-logo";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { isHostedMode } from "@/lib/utils/env";

// The install's logo. Public: it is in the header of the pages signers see
// and at the top of the emails they get.

const YEAR_SECONDS = 365 * 24 * 60 * 60;

function notFound() {
  return new Response(null, {
    headers: { "cache-control": "public, max-age=60" },
    status: 404,
  });
}

export async function GET(request: Request) {
  if (isHostedMode()) {
    return notFound();
  }

  try {
    const logo = await readBrandLogo();

    if (!logo) {
      return notFound();
    }

    // Pages and emails ask for the logo by its version, which is part of
    // the image's hash: that address never shows anything else, so it can
    // be kept for good. Asked for any other way, the answer is kept only
    // briefly, since the logo may change.
    const requested = new URL(request.url).searchParams.get("v");
    const cacheControl =
      requested === logo.version
        ? `public, max-age=${YEAR_SECONDS}, s-maxage=${YEAR_SECONDS}, immutable`
        : "public, max-age=300";

    return new Response(Buffer.from(logo.bytes), {
      headers: {
        "cache-control": cacheControl,
        "content-disposition": "inline",
        "content-length": String(logo.bytes.byteLength),
        // An image and nothing else, whatever is in the file.
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": logo.contentType,
        "cross-origin-resource-policy": "cross-origin",
        "x-content-type-options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    logRouteError(error, {
      category: "brand_logo_read_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while loading the logo.",
      path: getRequestPathname(request),
    });

    return new Response(null, {
      headers: { "cache-control": "no-store" },
      status: 500,
    });
  }
}
