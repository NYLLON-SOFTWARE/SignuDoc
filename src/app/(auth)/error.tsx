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
        description="This page hit an unexpected error. Please try again."
        footer={
          <button
            className="btn-quiet min-h-11 px-5"
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
