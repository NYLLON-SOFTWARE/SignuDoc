"use client";

import { FileTextIcon } from "lucide-react";

import { Brand } from "@/components/layout/brand";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import type {
  SigningPayload,
  SigningVerificationState,
} from "@/lib/schemas/signing";
import { SignerVerificationScreen } from "./signer-verification-screen";
import {
  SigningLiveShell,
  type ProviderSignatureProblem,
} from "./signing-live-shell";

type SigningUnavailableState =
  "already-signed" | "declined" | "error" | "expired" | "voided";

type SigningShellProps = {
  initialState?: SigningUnavailableState;
  record?: SigningPayload;
  /** Set when the signer came back from a signing provider without signing. */
  signatureProblem?: ProviderSignatureProblem | null;
  token: string;
  verification?: SigningVerificationState;
};

const tokenStateCopy: Record<
  SigningUnavailableState,
  { description: string; title: string }
> = {
  error: {
    title: "Something went wrong. Please try again.",
    description:
      "We couldn't load this document right now. Reload the page or request a fresh signing link from the sender.",
  },
  expired: {
    title: "This link has expired",
    description: "Request a new signing link from the sender.",
  },
  "already-signed": {
    title: "You've already signed",
    description: "You already completed your signature for this document.",
  },
  voided: {
    title: "This envelope has been voided",
    description:
      "The sender cancelled this document. No further action is needed.",
  },
  declined: {
    title: "This envelope has been declined",
    description:
      "A signer declined this document. No further action is needed.",
  },
};

export function SigningShell({
  initialState,
  record,
  signatureProblem,
  token,
  verification,
}: SigningShellProps) {
  if (record) {
    return (
      <SigningLiveShell record={record} signatureProblem={signatureProblem} />
    );
  }

  if (verification) {
    return <SignerVerificationScreen state={verification} token={token} />;
  }

  const tokenState = tokenStateCopy[initialState ?? "error"];

  return (
    <StandaloneStateScreen
      description={tokenState.description}
      title={tokenState.title}
    />
  );
}

function StandaloneStateScreen({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header>
        <div className="page-width flex items-center py-4">
          <Brand href="/" />
        </div>
      </header>
      <main className="page-width flex flex-1 items-center justify-center py-10">
        <section
          className="panel w-full max-w-[640px] px-6 py-12 text-center sm:px-12 sm:py-14"
          data-animate="enter"
        >
          <span
            aria-hidden="true"
            className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-(--accent-soft) text-(--accent)"
          >
            <FileTextIcon className="size-6" strokeWidth={2.2} />
          </span>
          <h1 className="mt-6 text-[clamp(1.625rem,4vw,2.125rem)] font-extrabold leading-tight tracking-[-0.03em] text-(--fg)">
            {title}
          </h1>
          <p className="mx-auto mt-3 max-w-[460px] text-base leading-7 text-(--secondary)">
            {description}
          </p>
        </section>
      </main>
      <PublicLegalFooter />
    </div>
  );
}
