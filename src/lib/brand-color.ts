// An install's own color.
//
// The administrator picks one color. Everything the pages need is worked
// out from it: the color itself for buttons (darkened until white text on
// it is readable), a darker shade for hover and for text, and pale tints
// for backgrounds. Nothing here trusts its input: the only thing that ever
// reaches a page is a set of six-digit hex colors built from numbers.

export type BrandPalette = {
  /** Buttons, links and focus rings. White text on it is readable. */
  accent: string;
  accentHover: string;
  /** Text in the brand color, readable on white and on the pale tints. */
  accentInk: string;
  /** "83 64 214", for shades with transparency. */
  accentRgb: string;
  accentSoft: string;
  accentSoftHover: string;
  accentSofter: string;
};

/** The accent the design ships with. Keep in step with globals.css. */
export const DEFAULT_BRAND_COLOR = "#5340d6";

export const DEFAULT_BRAND_PALETTE: BrandPalette = {
  accent: DEFAULT_BRAND_COLOR,
  accentHover: "#4433b8",
  accentInk: "#4433b8",
  accentRgb: "83 64 214",
  accentSoft: "#ece9fd",
  accentSoftHover: "#e0dbfb",
  accentSofter: "#f4f2ff",
};

type Rgb = [red: number, green: number, blue: number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** WCAG AA for normal text. */
const READABLE_CONTRAST = 4.5;

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * "#1A73E8", "1a73e8" or "#17e" as "#1a73e8". Null for anything that is not
 * a plain hex color.
 */
export function normalizeBrandColor(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }

  const match = HEX_COLOR.exec(input.trim());

  if (!match) {
    return null;
  }

  const digits = match[1].toLowerCase();

  return digits.length === 3
    ? `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`
    : `#${digits}`;
}

function toRgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex(color: Rgb): string {
  return `#${color
    .map((channel) =>
      Math.min(255, Math.max(0, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** `amount` of `other` mixed into `color`, from 0 (none) to 1 (all). */
function mix(color: Rgb, other: Rgb, amount: number): Rgb {
  return [
    color[0] + (other[0] - color[0]) * amount,
    color[1] + (other[1] - color[1]) * amount,
    color[2] + (other[2] - color[2]) * amount,
  ];
}

function relativeLuminance(color: Rgb): number {
  const [red, green, blue] = color.map((channel) => {
    const value = Math.min(255, Math.max(0, Math.round(channel))) / 255;

    return value <= 0.039_28
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: Rgb, second: Rgb): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));

  return (lighter + 0.05) / (darker + 0.05);
}

/** The WCAG contrast ratio between two hex colors, from 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  return contrast(toRgb(first), toRgb(second));
}

/**
 * The color, darkened a little at a time until text in it (or white text on
 * it) is readable against every background given. Black always is, so this
 * ends.
 */
function darkenUntilReadable(color: Rgb, backgrounds: Rgb[]): Rgb {
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mix(color, BLACK, step / 100);

    if (
      backgrounds.every(
        (background) => contrast(candidate, background) >= READABLE_CONTRAST,
      )
    ) {
      return candidate;
    }
  }

  return BLACK;
}

/** The shades the pages use, worked out from one color. */
export function buildBrandPalette(color: string): BrandPalette | null {
  const normalized = normalizeBrandColor(color);

  if (!normalized) {
    return null;
  }

  // Rounded to whole channels straight away, so the readability checks
  // below judge the colors that will really be on the page.
  const accent = toRgb(toHex(darkenUntilReadable(toRgb(normalized), [WHITE])));
  const accentSoft = toRgb(toHex(mix(WHITE, accent, 0.11)));
  const accentSoftHover = toRgb(toHex(mix(WHITE, accent, 0.18)));
  const accentSofter = mix(WHITE, accent, 0.065);
  const accentHover = toRgb(toHex(mix(accent, BLACK, 0.16)));
  // Brand-colored text sits on white, on the page and on both tints. The
  // darker tint is the hardest of them to read against.
  const accentInk = darkenUntilReadable(accentHover, [
    accentSoftHover,
    accentSoft,
  ]);

  return {
    accent: toHex(accent),
    accentHover: toHex(accentHover),
    accentInk: toHex(accentInk),
    accentRgb: accent.join(" "),
    accentSoft: toHex(accentSoft),
    accentSoftHover: toHex(accentSoftHover),
    accentSofter: toHex(accentSofter),
  };
}

/**
 * A style rule that replaces the default accent with this color, or null
 * when the color is not one. Safe to put in a page: every value in it is a
 * hex color or three numbers made here.
 */
export function buildBrandColorCss(color: string | null): string | null {
  const palette = color ? buildBrandPalette(color) : null;

  if (!palette) {
    return null;
  }

  return `:root{${Object.entries(brandPaletteVariables(palette))
    .map(([name, value]) => `${name}:${value};`)
    .join("")}}`;
}

/** The palette as the custom properties the stylesheet reads. */
export function brandPaletteVariables(
  palette: BrandPalette,
): Record<string, string> {
  return {
    "--accent": palette.accent,
    "--accent-hover": palette.accentHover,
    "--accent-ink": palette.accentInk,
    "--accent-rgb": palette.accentRgb,
    "--accent-soft": palette.accentSoft,
    "--accent-soft-hover": palette.accentSoftHover,
    "--accent-softer": palette.accentSofter,
  };
}
