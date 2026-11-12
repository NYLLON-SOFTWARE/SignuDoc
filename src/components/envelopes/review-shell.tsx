"use client";

import { useEffect, useRef, useState } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StatusPanel } from "@/components/shared/status-panel";
import { StepIndicator } from "@/components/shared/step-indicator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ReviewEnvelopeData } from "@/lib/envelopes";
import { PERMITTED_USE_PATH } from "@/lib/permitted-uses";
import { getSignerPalette } from "./signer-palette";

const envelopeSteps = ["Upload", "Signers", "Place fields", "Review"];
const redirectDelayMs = 1200;
const defaultSendErrorMessage = "Failed to send. Please try again.";

type ReviewShellProps = {
  envelopeId: string;
  initialState?: "error";
  record?: ReviewEnvelopeData;
};

type ReviewRecordView = {
  filename: string;
  pageCount: number;
  signers: readonly ReviewSigner[];
  sizeLabel: string;
  title: string;
};

type ReviewFieldSummaryLabel =
  "Checkbox" | "Date" | "Initials" | "Signature" | "Text";

type ReviewSigner = {
  color?: string;
  email: string;
  fieldSummaries: readonly ReviewFieldSummaryLabel[];
  id: string;
  name: string;
  order: number;
  tint?: string;
};

type SendPhase = "error" | "idle" | "sending";

function buildSuccessMessage(firstSignerName: string) {
  return `Envelope sent. ${firstSignerName} has been notified.`;
}

export function ReviewShell({
  envelopeId,
  initialState,
  record,
}: ReviewShellProps) {
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendPhase, setSendPhase] = useState<SendPhase>("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const sendTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (sendTimeoutRef.current) {
        window.clearTimeout(sendTimeoutRef.current);
      }
    };
  }, []);

  function closeConfirmation() {
    if (sendPhase === "sending") {
      return;
    }

    setSendPhase("idle");
    setIsConfirmationOpen(false);
  }

  function openConfirmation() {
    setNotice(null);
    setSendError(null);
    setSendPhase("idle");
    setIsConfirmationOpen(true);
  }

  async function handleConfirmSend() {
    if (sendPhase === "sending") {
      return;
    }

    if (sendTimeoutRef.current) {
      window.clearTimeout(sendTimeoutRef.current);
      sendTimeoutRef.current = null;
    }

    setSendError(null);
    setSendPhase("sending");

    try {
      const response = await fetch(`/api/envelopes/${envelopeId}/send`, {
        body: JSON.stringify({
          permittedUseConfirmed: true,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        notifiedSignerName?: string;
        redirectPath?: string;
      } | null;

      if (!response.ok) {
        setSendError(payload?.error ?? defaultSendErrorMessage);
        setSendPhase("error");
        return;
      }

      const notifiedSignerName =
        payload?.notifiedSignerName?.trim() || firstSigner?.name || "Signer 1";
      const redirectPath = payload?.redirectPath || `/envelopes/${envelopeId}`;

      setIsConfirmationOpen(false);
      setNotice(buildSuccessMessage(notifiedSignerName));
      setSendPhase("idle");
      sendTimeoutRef.current = window.setTimeout(() => {
        window.location.assign(redirectPath);
      }, redirectDelayMs);
    } catch {
      setSendError(defaultSendErrorMessage);
      setSendPhase("error");
    }
  }

  if (initialState === "error") {
    return (
      <div className="space-y-6">
        <PageHeader
          description="Step 4 of 4 - Review and send"
          title="New envelope"
        />
        <StepIndicator current={4} steps={envelopeSteps} />
        <StatusPanel
          footer={
            <ShellButton
              onClick={() => window.location.reload()}
              variant="secondary"
            >
              Retry
            </ShellButton>
          }
          description="We couldn't load this draft summary. Try again after checking the earlier steps."
          title="Couldn't load the review summary"
          tone="error"
        />
      </div>
    );
  }

  if (!record || record.isEmpty) {
    return (
      <div className="space-y-6">
        <PageHeader
          description="Step 4 of 4 - Review and send"
          title="New envelope"
        />
        <StepIndicator current={4} steps={envelopeSteps} />
        <StatusPanel
          action={{
            href: `/envelopes/${envelopeId}/prepare`,
            label: "Back to prepare",
          }}
          description="Add signers and place fields before you review the final summary for this envelope."
          eyebrow="Incomplete draft"
          title="Nothing to review yet"
        />
      </div>
    );
  }

  const activeRecord: ReviewRecordView = {
    filename: record.filename,
    pageCount: record.pageCount,
    signers: record.signers.map((signer) => ({ ...signer })),
    sizeLabel: record.sizeLabel,
    title: record.title,
  };
  const canSend = Boolean(record.canSend);
  const disabledReason = record.disabledReason ?? null;
  const firstSigner = activeRecord.signers[0];

  return (
    <div className="space-y-8">
      <PageHeader
        description="Step 4 of 4 - Review and send"
        eyebrow="Envelope workflow"
        title="New envelope"
      />

      <StepIndicator current={4} steps={envelopeSteps} />

      {notice ? (
        <section
          className="border border-[rgba(5,150,105,0.18)] bg-[rgba(5,150,105,0.05)] px-5 py-4"
          role="status"
        >
          <p className="text-sm font-semibold text-chart-4">{notice}</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Opening the envelope detail view...
          </p>
        </section>
      ) : null}

      <section
        className="editorial-panel p-6 sm:p-8"
        data-animate="enter"
        data-animate-delay="2"
      >
        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)]">
          <article className="border border-(--border) bg-(--surface) p-5 sm:p-6">
            <div className="space-y-3">
              <p className="section-eyebrow">Document</p>
              <div className="space-y-2">
                <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-(--fg)">
                  {activeRecord.title}
                </h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  {activeRecord.filename} - {activeRecord.pageCount} pages -{" "}
                  {activeRecord.sizeLabel}
                </p>
              </div>
            </div>
          </article>

          <article className="border border-(--border) bg-white p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-[-0.03em] text-(--fg)">
                Signing order
              </h2>
              <span className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
                {activeRecord.signers.length}{" "}
                {activeRecord.signers.length === 1 ? "signer" : "signers"}
              </span>
            </div>

            <ol className="mt-5 space-y-4">
              {activeRecord.signers.map((signer, index) => {
                const palette =
                  signer.color && signer.tint
                    ? { color: signer.color, tint: signer.tint }
                    : getSignerPalette(index);

                return (
                  <li
                    className="border border-(--border) bg-(--surface) p-4"
                    key={signer.id}
                  >
                    <div className="flex items-start gap-4">
                      <span
                        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                        style={{
                          backgroundColor: palette.tint,
                          color: palette.color,
                        }}
                      >
                        {signer.order}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-base font-semibold text-(--fg)">
                              {signer.name}
                            </p>
                            <p className="truncate text-sm text-muted-foreground">
                              {signer.email}
                            </p>
                          </div>
                          <span
                            className="inline-flex w-fit items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]"
                            style={{
                              backgroundColor: palette.tint,
                              color: palette.color,
                            }}
                          >
                            <span
                              aria-hidden="true"
                              className="size-2 rounded-full"
                              style={{ backgroundColor: palette.color }}
                            />
                            Signer {signer.order}
                          </span>
                        </div>

                        <p
                          className={`mt-3 text-sm leading-6 ${
                            signer.fieldSummaries.includes("Signature")
                              ? "text-muted-foreground"
                              : "font-semibold text-(--accent)"
                          }`}
                        >
                          {formatSignerFieldSummary(signer.fieldSummaries)}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </article>
        </div>

        <div className="mt-6 border border-(--border) bg-white px-5 py-5 sm:px-6">
          <p className="text-sm leading-7 text-muted-foreground">
            After you send, Signer 1 will receive an email with a link to sign.
            Each signer is notified in order after the previous signer
            completes.
          </p>
        </div>

        {disabledReason ? (
          <div
            className="mt-6 border border-[rgba(180,35,53,0.18)] bg-[rgba(180,35,53,0.04)] px-5 py-4"
            role="alert"
          >
            <p className="text-sm font-semibold text-(--accent)">
              {disabledReason}
            </p>
          </div>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <ShellButton
            href={`/envelopes/${envelopeId}/prepare`}
            variant="secondary"
          >
            ← Back
          </ShellButton>
          <ShellButton disabled={!canSend} onClick={openConfirmation}>
            Send envelope
          </ShellButton>
        </div>
      </section>

      {isConfirmationOpen ? (
        <SendConfirmationDialog
          errorMessage={sendPhase === "error" ? sendError : null}
          firstSignerName={firstSigner?.name ?? "Signer 1"}
          isSending={sendPhase === "sending"}
          onCancel={closeConfirmation}
          onConfirm={handleConfirmSend}
          signerCount={activeRecord.signers.length}
          title={activeRecord.title}
        />
      ) : null}
    </div>
  );
}

type SendConfirmationDialogProps = {
  errorMessage: string | null;
  firstSignerName: string;
  isSending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  signerCount: number;
  title: string;
};

function SendConfirmationDialog({
  errorMessage,
  firstSignerName,
  isSending,
  onCancel,
  onConfirm,
  signerCount,
  title,
}: SendConfirmationDialogProps) {
  const [isPermittedUseConfirmed, setIsPermittedUseConfirmed] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSending) {
          onCancel();
        }
      }}
    >
      <DialogContent
        className="max-w-md rounded-none border-(--border) sm:p-8"
        showCloseButton={false}
      >
        <div className="space-y-4">
          <DialogHeader className="space-y-3">
            <DialogTitle className="text-xl tracking-[-0.03em]">
              Send this envelope?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm leading-6 text-muted-foreground">
                <p>
                  &quot;{title}&quot; will be sent to {signerCount}{" "}
                  {signerCount === 1 ? "signer" : "signers"}.{" "}
                  {signerCount === 1
                    ? `${firstSignerName} will be notified immediately.`
                    : `The first signer (${firstSignerName}) will be notified immediately.`}
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>

          <label className="block border border-(--border) bg-(--surface) px-4 py-4">
            <span className="flex items-start gap-3">
              <Checkbox
                autoFocus
                checked={isPermittedUseConfirmed}
                className="mt-1"
                disabled={isSending}
                onCheckedChange={(checked) =>
                  setIsPermittedUseConfirmed(checked === true)
                }
              />
              <span className="text-sm leading-6 text-muted-foreground">
                By sending, you confirm this document is an ordinary business
                agreement and not a will, court order, legally required consumer
                disclosure, or other{" "}
                <a
                  className="font-semibold text-(--fg)"
                  href={PERMITTED_USE_PATH}
                  rel="noreferrer"
                  style={{
                    textDecorationColor: "rgba(17,17,17,0.35)",
                    textDecorationLine: "underline",
                    textDecorationThickness: "1px",
                    textUnderlineOffset: "4px",
                  }}
                  target="_blank"
                >
                  document that cannot be signed electronically
                </a>
                .
              </span>
            </span>
          </label>

          {errorMessage ? (
            <div
              className="border border-[rgba(180,35,53,0.18)] bg-[rgba(180,35,53,0.04)] px-4 py-3"
              role="alert"
            >
              <p className="text-sm font-semibold text-(--accent)">
                {errorMessage}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-3 pt-2">
            <ShellButton
              disabled={isSending}
              onClick={onCancel}
              variant="secondary"
            >
              Cancel
            </ShellButton>
            <ShellButton
              disabled={!isPermittedUseConfirmed}
              loading={isSending}
              onClick={onConfirm}
            >
              {isSending ? "Sending..." : "Send now"}
            </ShellButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatSignerFieldSummary(fields: readonly ReviewFieldSummaryLabel[]) {
  const fieldCount = fields.length;

  if (fieldCount === 0) {
    return "No fields placed yet (0 fields)";
  }

  return `(${fieldCount} field${fieldCount === 1 ? "" : "s"})`;
}
