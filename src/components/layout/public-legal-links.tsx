"use client";

import Link from "next/link";
import { IBM_Plex_Mono } from "next/font/google";

import { useBranding } from "@/components/layout/branding-provider";
import { SIGNUDOC_NAME, SIGNUDOC_URL } from "@/lib/branding";
import { PUBLIC_COPYRIGHT_YEAR, publicFooterLinks } from "@/lib/legal";
import { cn } from "@/lib/cn";
import { PERMITTED_USE_PATH } from "@/lib/permitted-uses";

const ibmPlexMono = IBM_Plex_Mono({
  display: "swap",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

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
  const monoClassName = ibmPlexMono.className;
  const resolvedLinkClassName =
    linkClassName ??
    `${monoClassName} text-xs text-[#71717a] transition-colors hover:text-black`;
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
        // Without the organization's own policy, signers still get a
        // notice, built from the install's settings.
        branding.privacyUrl
          ? {
              external: true,
              href: branding.privacyUrl,
              label: labelVariant === "long" ? "Privacy Policy" : "Privacy",
            }
          : {
              external: false,
              href: "/signer-privacy",
              label: labelVariant === "long" ? "Privacy notice" : "Privacy",
            },
      ];

  // Which documents may be signed here: on every install.
  links.push({
    external: false,
    href: PERMITTED_USE_PATH,
    label: labelVariant === "long" ? "What this is for" : "E-signatures",
  });

  return (
    <footer
      className={cn(
        "relative z-10 border-t border-[#d4d4d4] bg-white",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto max-w-[1200px] px-6 py-8 sm:px-8 lg:px-10",
          contentClassName,
        )}
      >
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className={`${monoClassName} text-xs text-[#71717a]`}>
            © {PUBLIC_COPYRIGHT_YEAR} {branding.productName}
          </p>

          {links.length > 0 ? (
            <nav
              aria-label="Footer"
              className="flex flex-wrap items-center justify-center gap-6"
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

          {branding.hosted ? (
            <div className="hidden items-center gap-2 sm:flex">
              <span className="h-[2px] w-8 bg-[#e50000]" />
              <span className="inline-block h-[6px] w-[6px] rounded-full bg-[#e50000]" />
            </div>
          ) : (
            <a
              className={`${monoClassName} text-xs text-[#71717a] transition-colors hover:text-black`}
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
