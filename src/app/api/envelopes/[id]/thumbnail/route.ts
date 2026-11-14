import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  EnvelopeDocumentAccessError,
  getEnvelopeThumbnailForUser,
  saveEnvelopeThumbnailForUser,
} from "@/lib/envelopes";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_MAX_BYTES,
  ThumbnailValidationError,
} from "@/lib/services/thumbnails";
import { readLimitedBody } from "@/lib/utils/limited-body";

type EnvelopeThumbnailRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const privateNoStore = { "cache-control": "private, no-store" };

// The picture itself. The browser may keep its copy, but must ask here
// before showing it again, so every showing still takes a signed-in request
// from the account that owns the envelope. When the copy is still good the
// answer is a 304 with no picture in it, and nothing is read from file
// storage. A dashboard of twenty documents would otherwise take twenty reads
// each time it opens, out of the 10,000 a month that Vercel Blob's free
// plan allows before it stops serving files.
const privateRevalidate = { "cache-control": "private, no-cache" };

// The picture of a document's first page that the dashboard shows. Only the
// account that owns the envelope can read or write it.
export async function GET(
  request: Request,
  context: EnvelopeThumbnailRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;

  try {
    const thumbnail = await getEnvelopeThumbnailForUser(session.user.id, id, {
      database: getDb(),
      ifNoneMatch: request.headers.get("if-none-match"),
    });

    if (thumbnail.isNotModified) {
      return new Response(null, {
        headers: { ...privateRevalidate, etag: thumbnail.etag },
        status: 304,
      });
    }

    const { picture } = thumbnail;
    const headers = new Headers({
      ...privateRevalidate,
      "content-disposition": "inline",
      // Stored as a JPEG whatever the upload claimed to be, and served as
      // nothing else.
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": THUMBNAIL_CONTENT_TYPE,
      etag: thumbnail.etag,
      "x-content-type-options": "nosniff",
    });

    if (typeof picture.contentLength === "number") {
      headers.set("content-length", String(picture.contentLength));
    }

    return new Response(picture.stream, { headers, status: 200 });
  } catch (error) {
    if (error instanceof EnvelopeDocumentAccessError) {
      return NextResponse.json(
        { error: error.message },
        { headers: privateNoStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "envelope_thumbnail_read_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while loading a document thumbnail.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to load this thumbnail." },
      { headers: privateNoStore, status: 500 },
    );
  }
}

// The sender's browser draws the first page and sends it here: once when the
// PDF is uploaded, or later from the dashboard for an envelope that has none.
export async function PUT(
  request: Request,
  context: EnvelopeThumbnailRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "envelope_thumbnail_write",
    key: buildRateLimitKey(["envelope-thumbnail", session.user.id]),
    limit: 120,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");

  if (Number.isFinite(declaredLength) && declaredLength > THUMBNAIL_MAX_BYTES) {
    return NextResponse.json(
      { error: "The thumbnail is too large." },
      { status: 413 },
    );
  }

  const { id } = await context.params;

  try {
    const body = await readLimitedBody(request, THUMBNAIL_MAX_BYTES);

    if (!body) {
      return NextResponse.json(
        { error: "The thumbnail is too large." },
        { status: 413 },
      );
    }

    await saveEnvelopeThumbnailForUser(session.user.id, id, body, {
      database: getDb(),
    });

    return new Response(null, { headers: privateNoStore, status: 204 });
  } catch (error) {
    if (error instanceof ThumbnailValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof EnvelopeDocumentAccessError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "envelope_thumbnail_write_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while saving a document thumbnail.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to save this thumbnail." },
      { status: 500 },
    );
  }
}
