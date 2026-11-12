"use client";

import { useState } from "react";

import { ShellButton } from "@/components/shared/form-shell";

export function RenewDownloadButton({ token }: { token: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; maskedEmail: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleClick() {
    setState({ kind: "sending" });

    try {
      const response = await fetch(
        `/api/download/${encodeURIComponent(token)}/renew`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        maskedEmail?: string;
      } | null;

      if (!response.ok || !payload?.maskedEmail) {
        setState({
          kind: "error",
          message: payload?.error ?? "New links could not be sent right now.",
        });
        return;
      }

      setState({ kind: "sent", maskedEmail: payload.maskedEmail });
    } catch {
      setState({
        kind: "error",
        message: "New links could not be sent right now.",
      });
    }
  }

  return (
    <div className="space-y-4">
      {state.kind === "sent" ? (
        <p role="status" className="font-semibold text-(--fg)">
          New links are on their way to {state.maskedEmail}.
        </p>
      ) : (
        <ShellButton loading={state.kind === "sending"} onClick={handleClick}>
          {state.kind === "sending"
            ? "Sending..."
            : "Email me new download links"}
        </ShellButton>
      )}
      {state.kind === "error" ? (
        <p role="alert" className="text-(--accent)">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
