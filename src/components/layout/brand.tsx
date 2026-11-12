"use client";

import Link from "next/link";

import { useBranding } from "@/components/layout/branding-provider";
import { SIGNUDOC_NAME } from "@/lib/branding";

type BrandProps = {
  className?: string;
  compact?: boolean;
  href?: string;
  labelClassName?: string;
};

export function Brand({
  className = "",
  compact = false,
  href = "/",
  labelClassName = "",
}: BrandProps) {
  const { productName } = useBranding();

  return (
    <Link
      aria-label={productName}
      className={`inline-flex min-w-0 items-center text-(--fg) ${className}`}
      href={href}
    >
      {!compact ? (
        <span
          className={`max-w-[60vw] truncate text-[1.28rem] font-extrabold tracking-[-0.035em] sm:max-w-[22rem] sm:text-[1.45rem] ${labelClassName}`}
        >
          {productName === SIGNUDOC_NAME ? (
            <>
              Signu<span className="text-(--accent)">Doc</span>
            </>
          ) : (
            productName
          )}
        </span>
      ) : null}
    </Link>
  );
}
