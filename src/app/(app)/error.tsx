"use client";

import { StatusPanel } from "@/components/shared/status-panel";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <StatusPanel
      description="The shared sender shell is mounted, but this page failed to load. Try the route again."
      eyebrow="App shell"
      footer={
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-(--border) px-5 text-sm font-semibold text-(--fg) transition hover:bg-(--surface)"
          onClick={reset}
          type="button"
        >
          Try again
        </button>
      }
      title="We couldn't load this page."
      tone="error"
    />
  );
}
