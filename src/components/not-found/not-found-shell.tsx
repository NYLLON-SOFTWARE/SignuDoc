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
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <section
        className="panel w-full max-w-[560px] px-6 py-14 text-center sm:px-12 sm:py-16"
        data-animate="enter"
      >
        <p className="text-[4.5rem] font-extrabold leading-none tracking-[-0.05em] text-(--accent)">
          404
        </p>
        <h1 className="mt-4 text-[clamp(1.875rem,5vw,2.5rem)] font-extrabold leading-[1.08] tracking-[-0.035em] text-(--fg)">
          Page not found
        </h1>
        <p className="mx-auto mt-3 max-w-md text-base leading-7 text-(--secondary)">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>

        <div className="mt-8 flex justify-center">
          <ShellButton className="px-6" href={ctaHref}>
            {ctaLabel}
          </ShellButton>
        </div>
      </section>
    </main>
  );
}
