// A small picture of a document's first page, shown on the dashboard.
//
// The server never renders PDFs, so the sender's browser draws the first
// page and sends the result. That makes the picture untrusted input: it is
// only ever shown back to the account that sent it, and it is stored and
// served only if it really is a small JPEG.

export const THUMBNAIL_CONTENT_TYPE = "image/jpeg";
export const THUMBNAIL_MAX_BYTES = 256 * 1024;
export const THUMBNAIL_MAX_DIMENSION = 1200;
const THUMBNAIL_MIN_DIMENSION = 16;

/**
 * The name a browser quotes back to ask whether its copy of a thumbnail is
 * still good (an ETag).
 *
 * A document never changes once it is uploaded, and an envelope keeps the
 * first picture it is given (saveEnvelopeThumbnailForUser), so the name is
 * made from the envelope alone. That lets
 * "your copy is still good" be answered without reading the picture from
 * file storage, where every read counts against the store's allowance. The
 * version is here to be raised if thumbnails are ever drawn differently.
 */
export function buildThumbnailEtag(envelopeId: string): string {
  return `"thumbnail-v1-${envelopeId}"`;
}

/** Whether an If-None-Match header names this ETag. */
export function matchesEtag(
  ifNoneMatch: string | null | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  return ifNoneMatch.split(",").some((candidate) => {
    const name = candidate.trim();

    // A cache in between may have marked the name as weak. For "do I
    // already have this?" the two forms mean the same.
    return name === "*" || name.replace(/^W\//, "") === etag;
  });
}

export class ThumbnailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbnailValidationError";
  }
}

type JpegDimensions = {
  height: number;
  width: number;
};

function isStartOfFrameMarker(marker: number): boolean {
  // SOF0 to SOF15, leaving out the three in that range that are not frames:
  // the Huffman table (C4), the JPEG extension (C8) and arithmetic
  // conditioning (CC).
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

/**
 * Reads the size of a JPEG from its frame header, or returns null when the
 * bytes are not a JPEG that says how large it is.
 */
export function readJpegDimensions(bytes: Uint8Array): JpegDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;

  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }

    const marker = bytes[offset + 1];

    // Padding before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    // Markers that stand alone, with no length after them.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    // Image data or the end of the image before any frame header.
    if (marker === 0xda || marker === 0xd9) {
      return null;
    }

    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];

    if (segmentLength < 2) {
      return null;
    }

    if (isStartOfFrameMarker(marker)) {
      if (segmentLength < 7 || offset + 8 >= bytes.length) {
        return null;
      }

      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }

    offset += 2 + segmentLength;
  }

  return null;
}

/** Throws unless the bytes are a JPEG small enough to keep as a thumbnail. */
export function assertThumbnailImage(bytes: Uint8Array): JpegDimensions {
  if (bytes.length === 0) {
    throw new ThumbnailValidationError("The thumbnail is empty.");
  }

  if (bytes.length > THUMBNAIL_MAX_BYTES) {
    throw new ThumbnailValidationError("The thumbnail is too large.");
  }

  const dimensions = readJpegDimensions(bytes);

  // The frame header alone says nothing about the rest. A whole JPEG ends
  // with its end-of-image marker, and one that was cut short does not.
  const isWhole =
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;

  if (!dimensions || !isWhole) {
    throw new ThumbnailValidationError("The thumbnail must be a JPEG image.");
  }

  if (
    dimensions.width < THUMBNAIL_MIN_DIMENSION ||
    dimensions.height < THUMBNAIL_MIN_DIMENSION ||
    dimensions.width > THUMBNAIL_MAX_DIMENSION ||
    dimensions.height > THUMBNAIL_MAX_DIMENSION
  ) {
    throw new ThumbnailValidationError("The thumbnail is not a usable size.");
  }

  return dimensions;
}
