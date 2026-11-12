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
    <div className="min-h-screen bg-(--page)">
      <header className="sticky top-0 z-20 bg-[rgba(255,255,255,0.92)] shadow-[0_1px_0_rgba(28,29,43,0.06)] backdrop-blur-md">
        <div className="flex min-h-[4.5rem] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link className="btn-quiet min-h-11 px-3.5" href={backHref}>
            <ChevronLeftIcon aria-hidden="true" className="-ml-1 size-4" />
            {backLabel}
          </Link>
          <div className="min-w-0 text-center">
            <p className="truncate text-base font-extrabold tracking-[-0.02em] text-(--fg) sm:text-lg">
              {title}
            </p>
            <p className="section-eyebrow mt-0.5">{stepLabel}</p>
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
