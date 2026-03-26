"use client";

import { StatusPanel } from "@/components/shared/status-panel";

export default function CanvasError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <StatusPanel
        description="The full-screen document shell is mounted, but the canvas payload could not render."
        eyebrow="Canvas shell"
        footer={
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-(--border) px-5 text-sm font-semibold text-(--fg) transition hover:bg-(--surface)"
            onClick={reset}
            type="button"
          >
            Reload canvas
          </button>
        }
        title="We couldn't open this document."
        tone="error"
      />
    </div>
  );
}
