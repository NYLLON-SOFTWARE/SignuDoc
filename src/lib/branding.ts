import { normalizeBrandColor } from "./brand-color.ts";
import type { ResolvedSettings } from "./settings.ts";

// What an install calls itself.
//
// A neutral install (the default) carries the name of the organization that
// runs it, links to that organization's own terms and privacy policy, and
// says "Powered by SignuDoc" in the footer. Hosted mode (HOSTED_MODE=1) is
// SignuDoc run as a public service: its own name, landing page and legal
// pages. An install's own logo and color are not used there.

export const SIGNUDOC_NAME = "SignuDoc";
export const SIGNUDOC_URL = "https://signudoc.app";

/** Where the install's logo is served. Public: it is shown to signers. */
export const BRAND_LOGO_PATH = "/api/brand/logo";

/** The largest logo an install can upload. */
export const MAX_LOGO_BYTES = 512 * 1024;

export const LOGO_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

export function buildBrandLogoPath(version: string): string {
  return `${BRAND_LOGO_PATH}?v=${encodeURIComponent(version)}`;
}

export type Branding = {
  /** The install's own color as "#rrggbb", or null for the default violet. */
  brandColor: string | null;
  /** Where "Contact" should point: a page on this site, or null. */
  contactUrl: string | null;
  hosted: boolean;
  /**
   * The install's logo, as a path on this site, or null when it has none.
   * The path changes whenever the logo does, so it can be cached for good.
   */
  logoUrl: string | null;
  /** The organization's name, when one has been set. */
  organizationName: string | null;
  privacyUrl: string | null;
  /** The name shown in the header, in page titles and in emails. */
  productName: string;
  /** False when new accounts are not being accepted at all. */
  signupAvailable: boolean;
  supportAddress: string | null;
  termsUrl: string | null;
};

/** SignuDoc under its own name. Also what a page shows before it knows better. */
export const HOSTED_BRANDING: Branding = {
  brandColor: null,
  contactUrl: "/contact",
  hosted: true,
  logoUrl: null,
  organizationName: null,
  privacyUrl: "/privacy",
  productName: SIGNUDOC_NAME,
  signupAvailable: true,
  supportAddress: null,
  termsUrl: "/terms",
};

export function buildBranding(settings: ResolvedSettings): Branding {
  const signupAvailable =
    settings.signupMode === "open" ||
    (settings.signupMode === "domains" &&
      settings.allowedEmailDomains.length > 0);

  if (settings.hosted) {
    return {
      ...HOSTED_BRANDING,
      signupAvailable,
      supportAddress: settings.supportAddress,
    };
  }

  const organizationName = settings.organizationName?.trim() || null;

  return {
    brandColor: normalizeBrandColor(settings.brandColor),
    contactUrl: null,
    hosted: false,
    logoUrl:
      settings.logoVersion === null
        ? null
        : buildBrandLogoPath(settings.logoVersion),
    organizationName,
    privacyUrl: settings.privacyUrl,
    productName: organizationName ?? SIGNUDOC_NAME,
    signupAvailable,
    supportAddress: settings.supportAddress,
    termsUrl: settings.termsUrl,
  };
}
