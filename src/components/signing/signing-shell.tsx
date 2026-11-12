"use client";

import { Brand } from "@/components/layout/brand";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import type {
  SigningPayload,
  SigningVerificationState,
} from "@/lib/schemas/signing";
import { SignerVerificationScreen } from "./signer-verification-screen";
import { SigningLiveShell } from "./signing-live-shell";

type SigningUnavailableState =
  "already-signed" | "declined" | "error" | "expired" | "voided";

type SigningShellProps = {
  initialState?: SigningUnavailableState;
  record?: SigningPayload;
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
  token,
  verification,
}: SigningShellProps) {
  if (record) {
    return <SigningLiveShell record={record} />;
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
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-(--border) bg-white">
        <div className="mx-auto flex max-w-[1360px] items-center px-4 py-5 sm:px-6 lg:px-8">
          <Brand href="/" />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[1360px] flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <section className="editorial-panel w-full max-w-[760px] px-6 py-10 text-center sm:px-10 sm:py-12">
          <span className="inline-flex border border-(--accent) bg-[#fff8f8] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-(--accent)">
            Signing state
          </span>
          <h1 className="mt-6 text-[32px] font-extrabold tracking-[-0.05em] text-(--fg) sm:text-[38px]">
            {title}
          </h1>
          <p className="mx-auto mt-4 max-w-[520px] text-base leading-7 text-muted-foreground">
            {description}
          </p>
        </section>
      </main>
      <PublicLegalFooter />
    </div>
  );
}
