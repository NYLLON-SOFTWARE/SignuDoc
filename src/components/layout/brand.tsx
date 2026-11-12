"use client";

import Link from "next/link";

import { useBranding } from "@/components/layout/branding-provider";
import { cn } from "@/lib/cn";

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
      className={cn(
        "inline-flex min-w-0 items-center gap-2.5 text-(--fg)",
        className,
      )}
      href={href}
    >
      <BrandMark />
      {!compact ? (
        <span
          className={cn(
            "max-w-[52vw] truncate text-[1.125rem] font-extrabold tracking-[-0.02em] sm:max-w-[22rem] sm:text-[1.1875rem]",
            labelClassName,
          )}
        >
          {productName}
        </span>
      ) : null}
    </Link>
  );
}

/** The signature stroke on a violet tile. Decorative: the link carries the name. */
export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-[0.5625rem] bg-(--accent)",
        className,
      )}
    >
      <svg
        fill="none"
        height="16"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
        viewBox="0 0 24 24"
        width="16"
      >
        <path d="M4 16c3 0 4-8 7-8s2 7 5 7 2-3 4-3" />
      </svg>
    </span>
  );
}
