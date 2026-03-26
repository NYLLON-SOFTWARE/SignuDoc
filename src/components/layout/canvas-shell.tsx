import Link from "next/link";
import type { ReactNode } from "react";

import { ChevronLeftIcon } from "@/components/layout/nav-items";
import { Button } from "@/components/ui/button";

type CanvasShellProps = {
  backHref: string;
  backLabel: string;
  children: ReactNode;
  nextDisabled?: boolean;
  nextHref?: string;
  nextLabel?: string;
  nextLoading?: boolean;
  onNext?: () => void;
  stepLabel: string;
  title: string;
};

export function CanvasShell({
  backHref,
  backLabel,
  children,
  nextDisabled = true,
  nextHref,
  nextLabel,
  nextLoading = false,
  onNext,
  stepLabel,
  title,
}: CanvasShellProps) {
  const nextButtonLabel = nextLoading ? "Loading..." : (nextLabel ?? "Next");

  return (
    <div className="min-h-screen bg-(--canvas-wash)">
      <header className="sticky top-0 z-20 border-b border-(--border) bg-white">
        <div className="flex min-h-18 items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <Link
            className="inline-flex min-h-11 items-center gap-2 rounded-none border border-(--border) bg-white px-4 [font-family:var(--font-mono)] text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-(--fg) transition hover:border-black"
            href={backHref}
          >
            <ChevronLeftIcon className="size-4" />
            {backLabel}
          </Link>
          <div className="min-w-0 text-center">
            <p className="truncate text-base font-bold tracking-[-0.03em] text-(--fg) sm:text-lg">
              {title}
            </p>
            <p className="mt-1 section-eyebrow">
              {stepLabel}
            </p>
          </div>
          {nextHref && !nextDisabled && !nextLoading ? (
            <Button asChild>
              <Link href={nextHref}>{nextButtonLabel}</Link>
            </Button>
          ) : (
            <Button disabled={nextDisabled || nextLoading} onClick={onNext}>
              {nextButtonLabel}
            </Button>
          )}
        </div>
      </header>
      <main className="min-h-[calc(100vh-73px)]">{children}</main>
    </div>
  );
}
