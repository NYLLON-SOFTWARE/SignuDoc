"use client";

import { useEffect, useRef, useState } from "react";

import { DocumentThumbnail } from "@/components/shared/document-thumbnail";
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
import { formatReminderInterval } from "@/lib/services/reminders";
import {
  DEFAULT_ENVELOPE_DEADLINE_DAYS,
  DEFAULT_ENVELOPE_REMINDER_DAYS,
  ENVELOPE_DEADLINE_DAY_OPTIONS,
  ENVELOPE_REMINDER_DAY_OPTIONS,
} from "@/lib/types/domain";
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
  const [deadlineDays, setDeadlineDays] = useState<number>(
    DEFAULT_ENVELOPE_DEADLINE_DAYS,
  );
  const [reminderDays, setReminderDays] = useState<number | null>(
    DEFAULT_ENVELOPE_REMINDER_DAYS,
  );
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
          expiresInDays: deadlineDays,
          permittedUseConfirmed: true,
          reminderIntervalDays: reminderDays,
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
      <div className="space-y-5">
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
      <div className="space-y-5">
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
    <div className="space-y-5">
      <PageHeader
        description="Step 4 of 4 - Review and send"
        title="New envelope"
      />

      <StepIndicator current={4} steps={envelopeSteps} />

      {notice ? (
        <section className="notice notice-success" role="status">
          <p>{notice}</p>
          <p className="mt-0.5 font-medium text-(--secondary)">
            Opening the envelope detail view...
          </p>
        </section>
      ) : null}

      <section
        className="panel p-5 sm:p-8"
        data-animate="enter"
        data-animate-delay="2"
      >
        <div className="grid gap-5 lg:grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)]">
          <article className="well flex flex-col gap-5 p-5 sm:p-6">
            <p className="section-eyebrow">Document</p>
            <div className="flex h-56 items-center justify-center">
              <DocumentThumbnail
                envelopeId={envelopeId}
                title={activeRecord.title}
              />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-[1.375rem] font-extrabold leading-tight text-(--fg)">
                {activeRecord.title}
              </h2>
              <p className="text-sm leading-6 text-(--secondary)">
                {activeRecord.filename} - {activeRecord.pageCount} pages -{" "}
                {activeRecord.sizeLabel}
              </p>
            </div>
          </article>

          <article className="min-w-0">
            <div className="flex items-center justify-between gap-3 px-1">
              <h2 className="text-lg font-extrabold text-(--fg)">
                Signing order
              </h2>
              <span className="pill pill-neutral">
                {activeRecord.signers.length}{" "}
                {activeRecord.signers.length === 1 ? "signer" : "signers"}
              </span>
            </div>

            <ol className="mt-4 space-y-3">
              {activeRecord.signers.map((signer, index) => {
                const palette =
                  signer.color && signer.tint
                    ? { color: signer.color, tint: signer.tint }
                    : getSignerPalette(index);

                return (
                  <li className="well p-4" key={signer.id}>
                    <div className="flex items-start gap-3.5">
                      <span
                        className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold"
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
                            <p className="truncate text-[0.9375rem] font-bold text-(--fg)">
                              {signer.name}
                            </p>
                            <p className="truncate text-sm text-(--secondary)">
                              {signer.email}
                            </p>
                          </div>
                          <span
                            className="pill w-fit"
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
                          className={`mt-2 text-sm leading-6 ${
                            signer.fieldSummaries.includes("Signature")
                              ? "text-(--tertiary)"
                              : "font-semibold text-(--danger)"
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

            <p className="notice notice-accent mt-4 font-medium">
              After you send, Signer 1 will receive an email with a link to
              sign. Each signer is notified in order after the previous signer
              completes.
            </p>

            <div className="well mt-4 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5">
                  <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                    Signing deadline
                  </span>
                  <select
                    className="field-input"
                    disabled={sendPhase === "sending" || Boolean(notice)}
                    onChange={(event) =>
                      setDeadlineDays(Number(event.target.value))
                    }
                    value={deadlineDays}
                  >
                    {ENVELOPE_DEADLINE_DAY_OPTIONS.map((days) => (
                      <option key={days} value={days}>
                        {days} days
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5">
                  <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                    Automatic reminders
                  </span>
                  <select
                    className="field-input"
                    disabled={sendPhase === "sending" || Boolean(notice)}
                    onChange={(event) =>
                      setReminderDays(
                        event.target.value === "off"
                          ? null
                          : Number(event.target.value),
                      )
                    }
                    value={reminderDays ?? "off"}
                  >
                    <option value="off">{formatReminderInterval(null)}</option>
                    {ENVELOPE_REMINDER_DAY_OPTIONS.map((days) => (
                      <option key={days} value={days}>
                        {formatReminderInterval(days)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="mt-3 text-sm leading-6 text-(--secondary)">
                Signing links stop working at the deadline. Reminders go to the
                signer whose turn it is until they sign. You can change both
                later from the envelope.
              </p>
            </div>
          </article>
        </div>

        {disabledReason ? (
          <div className="notice notice-danger mt-5" role="alert">
            <p>{disabledReason}</p>
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
          deadlineDays={deadlineDays}
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
  deadlineDays: number;
  errorMessage: string | null;
  firstSignerName: string;
  isSending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  signerCount: number;
  title: string;
};

function SendConfirmationDialog({
  deadlineDays,
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
      <DialogContent className="max-w-md sm:p-8" showCloseButton={false}>
        <div className="space-y-4">
          <DialogHeader className="space-y-3">
            <DialogTitle>Send this envelope?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm leading-6 text-(--secondary)">
                <p>
                  &quot;{title}&quot; will be sent to {signerCount}{" "}
                  {signerCount === 1 ? "signer" : "signers"}.{" "}
                  {signerCount === 1
                    ? `${firstSignerName} will be notified immediately.`
                    : `The first signer (${firstSignerName}) will be notified immediately.`}{" "}
                  The request expires in {deadlineDays} days.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>

          <label className="well block px-4 py-4">
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
              <span className="text-sm leading-6 text-(--secondary)">
                By sending, you confirm this document is an ordinary business
                agreement and not a will, court order, legally required consumer
                disclosure, or other{" "}
                <a
                  className="font-semibold text-(--accent-ink) underline decoration-[rgba(83,64,214,0.35)] underline-offset-4"
                  href={PERMITTED_USE_PATH}
                  rel="noreferrer"
                  target="_blank"
                >
                  document that cannot be signed electronically
                </a>
                .
              </span>
            </span>
          </label>

          {errorMessage ? (
            <div className="notice notice-danger" role="alert">
              <p>{errorMessage}</p>
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
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
