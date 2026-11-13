import assert from "node:assert/strict";
import test from "node:test";

import {
  BrandLogoError,
  MAX_LOGO_BYTES,
  checkLogoUpload,
  sniffLogoContentType,
} from "./brand-logo.ts";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46];
const WEBP = [
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
];

test("the kind of image is read from the bytes", () => {
  assert.equal(sniffLogoContentType(Uint8Array.from(PNG)), "image/png");
  assert.equal(sniffLogoContentType(Uint8Array.from(JPEG)), "image/jpeg");
  assert.equal(sniffLogoContentType(Uint8Array.from(WEBP)), "image/webp");
});

test("anything else is not a logo, SVG and HTML included", () => {
  const encoder = new TextEncoder();

  for (const bytes of [
    encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    encoder.encode("<!doctype html><script>alert(1)</script>"),
    encoder.encode("GIF89a"),
    encoder.encode("%PDF-1.7"),
    // A RIFF file that is not WebP (a WAV sound).
    Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]),
    Uint8Array.from([0x89, 0x50]),
  ]) {
    assert.equal(sniffLogoContentType(bytes), null);
    assert.throws(() => checkLogoUpload(bytes), BrandLogoError);
  }
});

test("an empty or oversized upload is refused with a reason", () => {
  assert.throws(
    () => checkLogoUpload(new Uint8Array()),
    (error: unknown) =>
      error instanceof BrandLogoError && error.statusCode === 400,
  );

  const tooLarge = new Uint8Array(MAX_LOGO_BYTES + 1);

  tooLarge.set(PNG);
  assert.throws(
    () => checkLogoUpload(tooLarge),
    (error: unknown) =>
      error instanceof BrandLogoError && error.statusCode === 413,
  );

  const largest = new Uint8Array(MAX_LOGO_BYTES);

  largest.set(PNG);
  assert.equal(checkLogoUpload(largest), "image/png");
});
