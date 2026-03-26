import Link from "next/link";
import { IBM_Plex_Mono } from "next/font/google";

import {
  PUBLIC_COPYRIGHT_YEAR,
  publicFooterLinks,
} from "@/lib/legal";
import { cn } from "@/lib/cn";

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

export function PublicLegalFooter({
  className = "",
  contentClassName = "",
  labelVariant = "short",
  linkClassName,
}: PublicLegalFooterProps) {
  const monoClassName = ibmPlexMono.className;

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
            © {PUBLIC_COPYRIGHT_YEAR} SignuDoc
          </p>

          <nav
            aria-label="Footer"
            className="flex flex-wrap items-center justify-center gap-6"
          >
            {publicFooterLinks.map((link) => (
              <Link
                className={
                  linkClassName ??
                  `${monoClassName} text-xs text-[#71717a] transition-colors hover:text-black`
                }
                href={link.href}
                key={link.href}
              >
                {labelVariant === "long" ? link.longLabel : link.shortLabel}
              </Link>
            ))}
          </nav>

          <div className="hidden items-center gap-2 sm:flex">
            <span className="h-[2px] w-8 bg-[#e50000]" />
            <span className="inline-block h-[6px] w-[6px] rounded-full bg-[#e50000]" />
          </div>
        </div>
      </div>
    </footer>
  );
}
