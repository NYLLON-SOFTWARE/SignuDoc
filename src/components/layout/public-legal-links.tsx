"use client";

import Link from "next/link";

import { useBranding } from "@/components/layout/branding-provider";
import { SIGNUDOC_NAME, SIGNUDOC_URL } from "@/lib/branding";
import { PUBLIC_COPYRIGHT_YEAR, publicFooterLinks } from "@/lib/legal";
import { cn } from "@/lib/cn";

type PublicLegalFooterProps = {
  className?: string;
  contentClassName?: string;
  labelVariant?: "long" | "short";
  linkClassName?: string;
};

type FooterLink = {
  external: boolean;
  href: string;
  label: string;
};

export function PublicLegalFooter({
  className = "",
  contentClassName = "",
  labelVariant = "short",
  linkClassName,
}: PublicLegalFooterProps) {
  const branding = useBranding();
  const resolvedLinkClassName =
    linkClassName ??
    "text-[0.8125rem] font-medium text-(--tertiary) transition-colors hover:text-(--accent-ink)";
  // The hosted service links to its own pages. Any other install links to
  // whatever terms and privacy policy its organization has published.
  const links: FooterLink[] = branding.hosted
    ? publicFooterLinks.map((link) => ({
        external: false,
        href: link.href,
        label: labelVariant === "long" ? link.longLabel : link.shortLabel,
      }))
    : [
        ...(branding.termsUrl
          ? [
              {
                external: true,
                href: branding.termsUrl,
                label: labelVariant === "long" ? "Terms of Service" : "Terms",
              },
            ]
          : []),
        ...(branding.privacyUrl
          ? [
              {
                external: true,
                href: branding.privacyUrl,
                label: labelVariant === "long" ? "Privacy Policy" : "Privacy",
              },
            ]
          : []),
      ];

  return (
    <footer className={cn("relative z-10", className)}>
      <div className={cn("page-width py-7", contentClassName)}>
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-[0.8125rem] text-(--tertiary)">
            © {PUBLIC_COPYRIGHT_YEAR} {branding.productName}
          </p>

          {links.length > 0 ? (
            <nav
              aria-label="Footer"
              className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
            >
              {links.map((link) =>
                link.external ? (
                  <a
                    className={resolvedLinkClassName}
                    href={link.href}
                    key={link.href}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {link.label}
                  </a>
                ) : (
                  <Link
                    className={resolvedLinkClassName}
                    href={link.href}
                    key={link.href}
                  >
                    {link.label}
                  </Link>
                ),
              )}
            </nav>
          ) : null}

          {branding.hosted ? null : (
            <a
              className={resolvedLinkClassName}
              href={SIGNUDOC_URL}
              rel="noreferrer"
              target="_blank"
            >
              Powered by {SIGNUDOC_NAME}
            </a>
          )}
        </div>
      </div>
    </footer>
  );
}
