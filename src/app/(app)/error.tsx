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
      description="Something went wrong while loading this page. Please try again."
      footer={
        <button
          className="btn-quiet min-h-11 px-5"
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
