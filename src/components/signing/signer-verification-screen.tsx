"use client";

import { useState, type FormEvent } from "react";

import { Brand } from "@/components/layout/brand";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type { SigningVerificationState } from "@/lib/schemas/signing";

type Method = SigningVerificationState["required"][number];

const METHOD_COPY: Record<Method, { helper: string; label: string }> = {
  access_code: {
    helper: "The sender gave you this code separately, for example by phone.",
    label: "Access code",
  },
  email_code: {
    helper: "We email a 6-digit code to the address this document was sent to.",
    label: "Code from your email",
  },
};

export function SignerVerificationScreen({
  state,
  token,
}: {
  state: SigningVerificationState;
  token: string;
}) {
  const method = state.pending[0]!;
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    state.emailCodeSentAt && method === "email_code"
      ? `A code was sent to ${state.maskedEmail}.`
      : null,
  );
  const [isChecking, setIsChecking] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const base = `/api/signing/${encodeURIComponent(token)}`;

  async function sendCode() {
    setIsSending(true);
    setError(null);

    try {
      const response = await fetch(`${base}/verify/email-code`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        maskedEmail?: string;
      } | null;

      if (!response.ok) {
        setError(payload?.error ?? "The code could not be sent right now.");
        return;
      }

      setNotice(
        `A code was sent to ${payload?.maskedEmail ?? state.maskedEmail}.`,
      );
    } catch {
      setError("The code could not be sent right now.");
    } finally {
      setIsSending(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsChecking(true);
    setError(null);

    try {
      const response = await fetch(`${base}/verify`, {
        body: JSON.stringify({ code, method }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;

      if (!response.ok) {
        setError(payload?.error ?? "The code could not be checked right now.");
        return;
      }

      // The page reads the new cookie and shows the next check or the
      // document.
      window.location.reload();
    } catch {
      setError("The code could not be checked right now.");
    } finally {
      setIsChecking(false);
    }
  }

  const copy = METHOD_COPY[method];
  const step = state.required.indexOf(method) + 1;

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-(--border) bg-white">
        <div className="mx-auto flex max-w-[1360px] items-center px-4 py-5 sm:px-6 lg:px-8">
          <Brand href="/" />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[1360px] flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <section className="editorial-panel w-full max-w-[560px] px-6 py-10 sm:px-10">
          <h1 className="text-[28px] font-extrabold tracking-[-0.04em] text-(--fg)">
            Confirm it&apos;s you
          </h1>
          <p className="mt-3 text-base leading-7 text-muted-foreground">
            {state.senderName} asked for a check before you open &ldquo;
            {state.envelopeTitle}&rdquo;.
            {state.required.length > 1
              ? ` Step ${String(step)} of ${String(state.required.length)}.`
              : ""}
          </p>
          <form className="mt-8 grid gap-5" onSubmit={handleSubmit}>
            <FieldShell
              autoComplete="one-time-code"
              helper={copy.helper}
              label={copy.label}
              name="signer-code"
              onChange={(event) => setCode(event.target.value)}
              readOnly={false}
              value={code}
            />
            {notice ? (
              <p className="text-sm text-muted-foreground" role="status">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p className="text-sm text-(--accent)" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex flex-col gap-3 sm:flex-row">
              <ShellButton
                disabled={code.trim().length === 0}
                loading={isChecking}
                type="submit"
              >
                Continue
              </ShellButton>
              {method === "email_code" ? (
                <ShellButton
                  loading={isSending}
                  onClick={sendCode}
                  variant="secondary"
                >
                  {notice ? "Send a new code" : "Email me a code"}
                </ShellButton>
              ) : null}
            </div>
          </form>
        </section>
      </main>
      <PublicLegalFooter />
    </div>
  );
}
