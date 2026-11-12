"use client";

import { useState, type ChangeEvent } from "react";

type VerifyAnswer =
  | { match: false }
  | {
      envelopeId: string;
      fileKind: "signed-document" | "certificate";
      finishedAt: number | null;
      match: true;
      signerCount: number;
      status: "completed" | "declined" | "voided";
      title: string;
    };

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});

const STATUS_WORDS = {
  completed: "completed",
  declined: "declined",
  voided: "voided",
} as const;

async function sha256OfFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function VerifyForm() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [answer, setAnswer] = useState<VerifyAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    setAnswer(null);
    setError(null);
    setHash(null);

    if (!file) {
      setFileName(null);
      return;
    }

    setFileName(file.name);
    setIsChecking(true);

    try {
      const sha256 = await sha256OfFile(file);

      setHash(sha256);

      const response = await fetch("/api/verify", {
        body: JSON.stringify({ sha256 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        (VerifyAnswer & { error?: string }) | null;

      if (!response.ok || !payload) {
        setError(payload?.error ?? "The file could not be checked right now.");
        return;
      }

      setAnswer(payload);
    } catch {
      setError("The file could not be read.");
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <div className="space-y-6">
      <label className="block border border-dashed border-(--border) bg-(--surface) px-6 py-8 text-center">
        <span className="block text-sm font-semibold text-(--fg)">
          Choose a signed PDF or audit certificate
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">
          The file stays on your device. Only its SHA-256 fingerprint is sent.
        </span>
        <input
          accept="application/pdf,.pdf"
          aria-label="PDF to verify"
          className="mx-auto mt-4 block text-sm"
          // One file at a time, so a verdict cannot land on the wrong one.
          disabled={isChecking}
          onChange={handleFile}
          type="file"
        />
      </label>

      <div aria-live="polite" className="space-y-3" role="status">
        {isChecking ? <p>Checking {fileName}...</p> : null}
        {error ? <p className="text-(--accent)">{error}</p> : null}
        {answer?.match === true ? (
          <div className="border border-[rgba(24,132,74,0.3)] bg-[rgba(24,132,74,0.06)] px-5 py-4 text-(--fg)">
            <p className="font-semibold">
              This file is unchanged. It is the{" "}
              {answer.fileKind === "signed-document"
                ? "signed document"
                : "audit certificate"}{" "}
              this site produced for &ldquo;{answer.title}&rdquo;.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              The envelope was {STATUS_WORDS[answer.status]}
              {answer.finishedAt
                ? ` on ${dateFormatter.format(new Date(answer.finishedAt * 1000))} UTC`
                : ""}{" "}
              with {answer.signerCount} signer
              {answer.signerCount === 1 ? "" : "s"}. Envelope ID{" "}
              {answer.envelopeId}.
            </p>
          </div>
        ) : null}
        {answer?.match === false ? (
          <div className="border border-[rgba(180,35,53,0.18)] bg-[rgba(180,35,53,0.06)] px-5 py-4 text-(--fg)">
            <p className="font-semibold">No match.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              This site did not produce this exact file. It may have been
              changed, saved again by another program, or come from somewhere
              else. Ask the sender for the copy kept on this site.
            </p>
          </div>
        ) : null}
        {hash ? (
          <p className="break-all font-mono text-xs text-muted-foreground">
            SHA-256: {hash}
          </p>
        ) : null}
      </div>
    </div>
  );
}
