import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBrandColorCss,
  buildBrandPalette,
  contrastRatio,
  normalizeBrandColor,
} from "./brand-color.ts";

test("normalizeBrandColor accepts plain hex colors only", () => {
  assert.equal(normalizeBrandColor("#1A73E8"), "#1a73e8");
  assert.equal(normalizeBrandColor(" 1a73e8 "), "#1a73e8");
  assert.equal(normalizeBrandColor("#17e"), "#1177ee");

  for (const input of [
    "",
    "red",
    "#12345",
    "#1234567",
    "#12345g",
    "rgb(1,2,3)",
    "#fff;}body{display:none",
    "url(https://example.com)",
    null,
    undefined,
    42,
  ]) {
    assert.equal(normalizeBrandColor(input), null, String(input));
  }
});

test("a color that is already readable is kept as it is", () => {
  const palette = buildBrandPalette("#5340d6");

  assert.ok(palette);
  assert.equal(palette.accent, "#5340d6");
  assert.equal(palette.accentRgb, "83 64 214");
  // Close to the tints the design was drawn with.
  assert.equal(palette.accentSoft, "#eceafa");
  assert.equal(palette.accentSofter, "#f4f3fc");
});

test("every palette is readable, whatever color it starts from", () => {
  const colors = [
    "#000000",
    "#ffffff",
    "#ffd400",
    "#00e676",
    "#ff0000",
    "#1a73e8",
    "#0b3d2e",
    "#ff69b4",
    "#808080",
    "#00ffff",
  ];

  for (const color of colors) {
    const palette = buildBrandPalette(color);

    assert.ok(palette, color);

    // White text on a button.
    assert.ok(contrastRatio(palette.accent, "#ffffff") >= 4.5, color);
    assert.ok(contrastRatio(palette.accentHover, "#ffffff") >= 4.5, color);

    // Brand-colored text on white, on the page and on the tints.
    for (const background of [
      "#ffffff",
      "#f3f4f8",
      palette.accentSoft,
      palette.accentSofter,
      palette.accentSoftHover,
    ]) {
      assert.ok(
        contrastRatio(palette.accentInk, background) >= 4.5,
        `${color} ink on ${background}`,
      );
    }

    for (const shade of Object.values(palette)) {
      assert.match(shade, /^(#[0-9a-f]{6}|\d{1,3} \d{1,3} \d{1,3})$/);
    }
  }
});

test("a light color is darkened rather than refused", () => {
  const palette = buildBrandPalette("#ffd400");

  assert.ok(palette);
  assert.notEqual(palette.accent, "#ffd400");
  assert.ok(contrastRatio(palette.accent, "#ffffff") >= 4.5);
});

test("buildBrandColorCss writes one rule made only of colors", () => {
  assert.equal(buildBrandColorCss(null), null);
  assert.equal(buildBrandColorCss("not a color"), null);
  assert.equal(buildBrandColorCss("#fff;}*{display:none}"), null);

  const css = buildBrandColorCss("#1A73E8");

  assert.ok(css);
  assert.match(
    css,
    /^:root\{(--accent(-[a-z]+)*:(#[0-9a-f]{6}|\d{1,3} \d{1,3} \d{1,3});)+\}$/,
  );
  assert.ok(css.includes("--accent:#1a73e8;"));
});

test("the default palette is the one the stylesheet ships with", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const { DEFAULT_BRAND_PALETTE, brandPaletteVariables } =
    await import("./brand-color.ts");

  for (const [name, value] of Object.entries(
    brandPaletteVariables(DEFAULT_BRAND_PALETTE),
  )) {
    assert.ok(css.includes(`${name}: ${value};`), `${name}: ${value}`);
  }
});
