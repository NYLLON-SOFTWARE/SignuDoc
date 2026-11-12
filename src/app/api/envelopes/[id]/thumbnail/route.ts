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

type EnvelopeThumbnailRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const privateNoStore = { "cache-control": "private, no-store" };

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
    });
    const headers = new Headers({
      // As private as the document it was drawn from, and served the same
      // way: the browser keeps no copy, so showing it always takes a
      // signed-in request from the account that owns the envelope.
      ...privateNoStore,
      "content-disposition": "inline",
      // Stored as a JPEG whatever the upload claimed to be, and served as
      // nothing else.
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": THUMBNAIL_CONTENT_TYPE,
      "x-content-type-options": "nosniff",
    });

    if (typeof thumbnail.contentLength === "number") {
      headers.set("content-length", String(thumbnail.contentLength));
    }

    return new Response(thumbnail.stream, { headers, status: 200 });
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

/** Reads the body, giving up as soon as it is larger than the limit. */
async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}
