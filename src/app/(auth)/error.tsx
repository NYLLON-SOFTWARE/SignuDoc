"use client";

import { StatusPanel } from "@/components/shared/status-panel";

export default function AuthError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="w-full max-w-[520px]">
      <StatusPanel
        description="The public route-group shell is ready, but this page hit an unexpected error."
        eyebrow="Auth shell"
        footer={
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-(--border) px-5 text-sm font-semibold text-(--fg) transition hover:bg-(--surface)"
            onClick={reset}
            type="button"
          >
            Try again
          </button>
        }
        title="Something went wrong."
        tone="error"
      />
    </div>
  );
}
