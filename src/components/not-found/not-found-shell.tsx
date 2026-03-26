"use client";

import { ShellButton } from "@/components/shared/form-shell";
import { resolveShellState } from "@/components/shared/shell-state";

export const notFoundShellStates = ["default", "authenticated"] as const;

export type NotFoundShellState = (typeof notFoundShellStates)[number];

type NotFoundShellProps = {
  initialState?: NotFoundShellState | string | string[] | null;
};

export function resolveNotFoundShellState(
  value?: string | string[] | null,
): NotFoundShellState {
  return resolveShellState(value, notFoundShellStates, "default");
}

export function NotFoundShell({
  initialState = "default",
}: NotFoundShellProps) {
  const resolvedInitialState = resolveNotFoundShellState(initialState);
  const authenticated = resolvedInitialState === "authenticated";
  const ctaHref = authenticated ? "/dashboard" : "/";
  const ctaLabel = authenticated ? "Go to Dashboard" : "Go to Home";

  return (
    <main className="min-h-screen bg-white px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-[1080px] items-center justify-center sm:min-h-[calc(100vh-4rem)]">
        <section className="relative w-full max-w-[620px] overflow-hidden border border-(--border) bg-white px-6 py-16 text-center sm:px-10 sm:py-20">
          <div className="relative">
            <p className="section-eyebrow">Unavailable</p>
            <h1 className="mt-4 text-[clamp(2.4rem,6vw,4rem)] font-extrabold leading-[1.02] tracking-[-0.05em] text-(--fg)">
              Page not found
            </h1>
            <p className="mx-auto mt-4 max-w-md text-sm leading-7 text-muted-foreground sm:text-base">
              The page you&apos;re looking for doesn&apos;t exist or has been
              moved.
            </p>

            <div className="mt-8 flex justify-center">
              <ShellButton className="px-6" href={ctaHref}>
                {ctaLabel}
              </ShellButton>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
