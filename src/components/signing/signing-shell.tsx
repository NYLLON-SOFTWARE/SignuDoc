"use client";

import type {
  SigningPayload,
  SigningVerificationState,
} from "@/lib/schemas/signing";
import { EmbedParentMessage } from "./embed-parent-message";
import { SignerVerificationScreen } from "./signer-verification-screen";
import { SigningStateScreen } from "./signing-state-screen";
import {
  SigningLiveShell,
  type ProviderSignatureProblem,
} from "./signing-live-shell";

type SigningUnavailableState =
  "already-signed" | "completed" | "declined" | "error" | "expired" | "voided";

type SigningShellProps = {
  /**
   * Set on an embedded signing page: the site framing it, which is told
   * when the signer signs or declines, or why the page cannot be used.
   */
  embedOrigin?: string | null;
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
    title: "You've already finished",
    description:
      "You already signed or approved this document. No further action is needed.",
  },
  completed: {
    title: "This envelope has been completed",
    description:
      "Everyone has signed this document. No further action is needed.",
  },
  voided: {
    title: "This envelope has been voided",
    description:
      "The sender cancelled this document. No further action is needed.",
  },
  declined: {
    title: "This envelope has been declined",
    description:
      "A signer declined, or an approver rejected, this document. No further action is needed.",
  },
};

export function SigningShell({
  embedOrigin = null,
  initialState,
  record,
  signatureProblem,
  token,
  verification,
}: SigningShellProps) {
  if (record) {
    return (
      <SigningLiveShell
        embedOrigin={embedOrigin}
        record={record}
        signatureProblem={signatureProblem}
      />
    );
  }

  if (verification) {
    return <SignerVerificationScreen state={verification} token={token} />;
  }

  const state = initialState ?? "error";
  const tokenState = tokenStateCopy[state];

  return (
    <>
      {embedOrigin ? (
        <EmbedParentMessage
          message={{ state, type: "signudoc:error" }}
          origin={embedOrigin}
        />
      ) : null}
      <SigningStateScreen
        description={
          embedOrigin && state === "expired"
            ? "Ask the app you are using for a new signing link."
            : tokenState.description
        }
        title={tokenState.title}
      />
    </>
  );
}
