import type { ResolvedSettings } from "./settings.ts";

// What an install calls itself.
//
// A neutral install (the default) carries the name of the organization that
// runs it, links to that organization's own terms and privacy policy, and
// says "Powered by SignuDoc" in the footer. Hosted mode (HOSTED_MODE=1) is
// SignuDoc run as a public service: its own name, landing page and legal
// pages.

export const SIGNUDOC_NAME = "SignuDoc";
export const SIGNUDOC_URL = "https://signudoc.app";

export type Branding = {
  /** Where "Contact" should point: a page on this site, or null. */
  contactUrl: string | null;
  hosted: boolean;
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
  contactUrl: "/contact",
  hosted: true,
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
    contactUrl: null,
    hosted: false,
    organizationName,
    privacyUrl: settings.privacyUrl,
    productName: organizationName ?? SIGNUDOC_NAME,
    signupAvailable,
    supportAddress: settings.supportAddress,
    termsUrl: settings.termsUrl,
  };
}
