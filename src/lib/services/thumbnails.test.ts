import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertThumbnailImage,
  readJpegDimensions,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_MAX_DIMENSION,
  ThumbnailValidationError,
} from "./thumbnails.ts";

const START_OF_IMAGE = [0xff, 0xd8];
const END_OF_IMAGE = [0xff, 0xd9];

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;

  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

function frameHeader(marker: number, width: number, height: number): number[] {
  return segment(marker, [
    8, // bits per sample
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3, // components
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
}

// Only the headers of a JPEG: enough to say what it is and how large,
// which is all the thumbnail check reads.
function buildJpeg({
  frameMarker = 0xc0,
  height = 621,
  leading = [],
  width = 480,
}: {
  frameMarker?: number;
  height?: number;
  leading?: number[];
  width?: number;
} = {}): Uint8Array {
  return Uint8Array.from([
    ...START_OF_IMAGE,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...leading,
    ...frameHeader(frameMarker, width, height),
    ...END_OF_IMAGE,
  ]);
}

test("reads the size of a baseline JPEG", () => {
  assert.deepEqual(readJpegDimensions(buildJpeg()), {
    height: 621,
    width: 480,
  });
});

test("reads the size of a progressive JPEG", () => {
  assert.deepEqual(
    readJpegDimensions(
      buildJpeg({ frameMarker: 0xc2, height: 300, width: 200 }),
    ),
    { height: 300, width: 200 },
  );
});

test("skips tables and padding that come before the frame header", () => {
  const huffmanTable = segment(0xc4, new Array<number>(20).fill(0));
  const quantizationTable = segment(0xdb, new Array<number>(65).fill(1));

  assert.deepEqual(
    readJpegDimensions(
      buildJpeg({ leading: [...quantizationTable, 0xff, ...huffmanTable] }),
    ),
    { height: 621, width: 480 },
  );
});

test("does not accept other kinds of file", () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d,
  ]);
  const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
  const html = new TextEncoder().encode("<html><script>alert(1)</script>");

  assert.equal(readJpegDimensions(png), null);
  assert.equal(readJpegDimensions(pdf), null);
  assert.equal(readJpegDimensions(html), null);
  assert.equal(readJpegDimensions(new Uint8Array()), null);
});

test("does not accept a JPEG that never says how large it is", () => {
  const headerOnly = Uint8Array.from([...START_OF_IMAGE, ...END_OF_IMAGE]);
  const truncatedFrame = buildJpeg().slice(0, 26);
  const imageDataFirst = Uint8Array.from([
    ...START_OF_IMAGE,
    ...segment(0xda, [0, 0, 0, 0]),
    ...frameHeader(0xc0, 480, 621),
  ]);

  assert.equal(readJpegDimensions(headerOnly), null);
  assert.equal(readJpegDimensions(truncatedFrame), null);
  assert.equal(readJpegDimensions(imageDataFirst), null);
});

test("accepts a thumbnail of a usable size", () => {
  assert.deepEqual(assertThumbnailImage(buildJpeg()), {
    height: 621,
    width: 480,
  });
  assert.doesNotThrow(() =>
    assertThumbnailImage(
      buildJpeg({
        height: THUMBNAIL_MAX_DIMENSION,
        width: THUMBNAIL_MAX_DIMENSION,
      }),
    ),
  );
});

test("refuses a thumbnail that is empty, too heavy, or not a JPEG", () => {
  const tooHeavy = new Uint8Array(THUMBNAIL_MAX_BYTES + 1);

  tooHeavy.set(buildJpeg());

  assert.throws(
    () => assertThumbnailImage(new Uint8Array()),
    ThumbnailValidationError,
  );
  assert.throws(() => assertThumbnailImage(tooHeavy), ThumbnailValidationError);
  assert.throws(
    () => assertThumbnailImage(new TextEncoder().encode("%PDF-1.7")),
    ThumbnailValidationError,
  );
});

test("refuses a thumbnail that was cut short", () => {
  // A frame header that says 16 by 16, and nothing after it.
  const headerOnly = Uint8Array.from([
    ...START_OF_IMAGE,
    ...[0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x10, 0x00, 0x10],
  ]);
  const cutShort = buildJpeg().slice(0, -1);

  assert.deepEqual(readJpegDimensions(headerOnly), { height: 16, width: 16 });
  assert.throws(
    () => assertThumbnailImage(headerOnly),
    ThumbnailValidationError,
  );
  assert.throws(() => assertThumbnailImage(cutShort), ThumbnailValidationError);
});

test("refuses a thumbnail whose picture is too large or too small", () => {
  assert.throws(
    () =>
      assertThumbnailImage(buildJpeg({ width: THUMBNAIL_MAX_DIMENSION + 1 })),
    ThumbnailValidationError,
  );
  assert.throws(
    () =>
      assertThumbnailImage(buildJpeg({ height: THUMBNAIL_MAX_DIMENSION + 1 })),
    ThumbnailValidationError,
  );
  assert.throws(
    () => assertThumbnailImage(buildJpeg({ height: 4, width: 4 })),
    ThumbnailValidationError,
  );
});
