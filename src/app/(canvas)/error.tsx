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
        description="Something went wrong while opening this document. Please try again."
        footer={
          <button
            className="btn-quiet min-h-11 px-5"
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
