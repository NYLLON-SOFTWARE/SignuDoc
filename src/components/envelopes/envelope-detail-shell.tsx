"use client";

import Link from "next/link";
import { useState } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import { StatusPanel } from "@/components/shared/status-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  EnvelopeDetailData,
  EnvelopeDetailTimelineItem,
} from "@/lib/envelopes";
import { getSignerPalette } from "./signer-palette";

type EnvelopeDetailShellProps = {
  envelopeId: string;
  initialState?: "error" | "not-found";
  record?: EnvelopeDetailData;
};

type EnvelopeStatus = "draft" | "sent" | "completed" | "declined" | "voided";

type SignerStatus = "signed" | "waiting" | "declined" | "pending";

type TimelineTone = "accent" | "danger" | "neutral" | "success";
type DownloadFileType = "evidence" | "signed";

type EnvelopeDetailSigner = {
  color?: string;
  email: string;
  id: string;
  metaLabel: string;
  name: string;
  order: number;
  status: SignerStatus;
  statusDateLabel?: string;
  tint?: string;
};

type EnvelopeDetailRecord = {
  createdAtLabel: string;
  signers: readonly EnvelopeDetailSigner[];
  status: EnvelopeStatus;
  timeline: readonly EnvelopeDetailTimelineItem[];
  title: string;
};

type ModalState = "delete-draft" | "void-envelope" | null;

const statusBadgeClasses: Record<EnvelopeStatus, string> = {
  completed: "bg-[rgba(5,150,105,0.12)] text-chart-4",
  declined: "bg-[rgba(255,0,51,0.1)] text-(--accent)",
  draft: "bg-[rgba(17,17,17,0.06)] text-muted-foreground",
  sent: "bg-[rgba(37,99,235,0.12)] text-chart-1",
  voided: "bg-[rgba(17,17,17,0.08)] text-(--tertiary)",
};

const statusLabelMap: Record<EnvelopeStatus, string> = {
  completed: "Completed",
  declined: "Declined",
  draft: "Draft",
  sent: "Sent",
  voided: "Voided",
};

const signerStatusBadgeClasses: Record<SignerStatus, string> = {
  declined: "bg-[rgba(255,0,51,0.1)] text-(--accent)",
  pending: "bg-[rgba(17,17,17,0.06)] text-muted-foreground",
  signed: "bg-[rgba(5,150,105,0.12)] text-chart-4",
  waiting: "bg-[rgba(37,99,235,0.12)] text-chart-1",
};

const signerStatusLabelMap: Record<SignerStatus, string> = {
  declined: "✗ Declined",
  pending: "— Pending",
  signed: "✓ Signed",
  waiting: "◷ Waiting",
};

const timelineToneClasses: Record<TimelineTone, string> = {
  accent: "bg-(--accent)",
  danger: "bg-[rgba(255,0,51,0.7)]",
  neutral: "bg-(--border)",
  success: "bg-(--signer-4)",
};

export function EnvelopeDetailShell({
  envelopeId,
  initialState,
  record,
}: EnvelopeDetailShellProps) {
  const [activeModal, setActiveModal] = useState<ModalState>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isDeletingDraft, setIsDeletingDraft] = useState(false);
  const [isSendingReminder, setIsSendingReminder] = useState(false);
  const [isVoidingEnvelope, setIsVoidingEnvelope] = useState(false);

  function handleRetry() {
    window.location.reload();
  }

  if (initialState === "error") {
    return (
      <StatusPanel
        description="Couldn't load this envelope. Please try again."
        footer={
          <ShellButton onClick={handleRetry} variant="secondary">
            Retry
          </ShellButton>
        }
        title="Couldn't load this envelope"
        tone="error"
      />
    );
  }

  if (initialState === "not-found") {
    return (
      <StatusPanel
        action={{ href: "/dashboard", label: "Back to documents" }}
        description="We couldn't find this envelope, or you no longer have access to it."
        eyebrow="Unavailable"
        title="This envelope is unavailable"
        tone="error"
      />
    );
  }

  if (!record) {
    return (
      <StatusPanel
        description="Couldn't load this envelope. Please try again."
        footer={
          <ShellButton onClick={handleRetry} variant="secondary">
            Retry
          </ShellButton>
        }
        title="Couldn't load this envelope"
        tone="error"
      />
    );
  }

  const activeRecord: EnvelopeDetailRecord = {
    createdAtLabel: record.createdAtLabel,
    signers: record.signers,
    status: record.status,
    timeline: record.timeline,
    title: record.title,
  };
  const manualReminderState = record.manualReminder ?? null;
  const reminderLimited =
    activeRecord.status === "sent" &&
    manualReminderState !== null &&
    !manualReminderState.canSend;
  const reminderHelperText =
    activeRecord.status === "sent" && manualReminderState?.nextAvailableAtLabel
      ? `You can send another reminder after ${manualReminderState.nextAvailableAtLabel}.`
      : null;
  const activeSigner =
    activeRecord.status === "sent"
      ? activeRecord.signers.find((signer) => signer.status === "waiting")
      : null;

  function handleDownload(fileType: DownloadFileType) {
    window.location.assign(
      `/api/envelopes/${encodeURIComponent(envelopeId)}/download?type=${fileType}`,
    );
  }

  async function handleSendReminder() {
    if (!activeSigner) {
      return;
    }

    setActionError(null);
    setIsSendingReminder(true);

    try {
      const response = await fetch(`/api/envelopes/${envelopeId}/nudge`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;

      if (
        response.ok ||
        response.status === 404 ||
        response.status === 409 ||
        response.status === 429
      ) {
        window.location.reload();
        return;
      }

      setActionError(payload?.error ?? "Unable to send a reminder right now.");
    } finally {
      setIsSendingReminder(false);
    }
  }

  async function handleConfirmDeleteDraft() {
    setActionError(null);
    setIsDeletingDraft(true);

    try {
      const response = await fetch(`/api/envelopes/${envelopeId}`, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectPath?: string;
      } | null;

      if (!response.ok) {
        setActionError(payload?.error ?? "Unable to delete this draft.");
        return;
      }

      window.location.assign(payload?.redirectPath ?? "/dashboard");
    } finally {
      setIsDeletingDraft(false);
    }
  }

  async function handleConfirmVoidEnvelope() {
    setActionError(null);
    setIsVoidingEnvelope(true);

    try {
      const response = await fetch(`/api/envelopes/${envelopeId}/void`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectPath?: string;
      } | null;

      if (response.ok) {
        window.location.assign(
          payload?.redirectPath ??
            `/envelopes/${encodeURIComponent(envelopeId)}`,
        );
        return;
      }

      if (response.status === 404 || response.status === 409) {
        window.location.reload();
        return;
      }

      setActionError(payload?.error ?? "Unable to void this envelope.");
    } finally {
      setIsVoidingEnvelope(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="editorial-panel p-6 sm:p-8" data-animate="enter">
        <Link
          className="inline-flex items-center text-sm font-semibold text-muted-foreground transition hover:text-(--fg)"
          href="/dashboard"
        >
          ← Documents
        </Link>

        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <h1
              className={`text-[28px] font-semibold tracking-[-0.04em] ${
                activeRecord.status === "voided"
                  ? "text-muted-foreground"
                  : "text-(--fg)"
              }`}
            >
              {activeRecord.title}
            </h1>
            <p className="text-sm text-muted-foreground">
              Created {activeRecord.createdAtLabel}
            </p>
          </div>
          <span
            className={`inline-flex w-fit rounded-full px-4 py-2 text-sm font-semibold ${statusBadgeClasses[activeRecord.status]}`}
          >
            {statusLabelMap[activeRecord.status]}
          </span>
        </div>

        {actionError ? (
          <div
            className="mt-5 border border-[rgba(180,35,53,0.2)] bg-[rgba(180,35,53,0.05)] px-4 py-3 text-sm font-medium text-(--fg)"
            role="alert"
          >
            {actionError}
          </div>
        ) : null}
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <article className="editorial-panel p-6 sm:p-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-[-0.03em] text-(--fg)">
              Signers
            </h2>
            <span className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
              {activeRecord.signers.length} total
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
                      aria-hidden="true"
                      className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                      style={{
                        backgroundColor: palette.tint,
                        color: palette.color,
                      }}
                    >
                      {signer.order}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="truncate text-base font-semibold text-(--fg)">
                            {signer.name}
                          </p>
                          <p className="truncate text-sm text-muted-foreground">
                            {signer.email}
                          </p>
                        </div>

                        <div className="space-y-2 sm:text-right">
                          <span
                            className={`inline-flex rounded-none px-3 py-1 [font-family:var(--font-mono)] text-[0.72rem] font-semibold uppercase tracking-[0.18em] ${signerStatusBadgeClasses[signer.status]}`}
                          >
                            {signerStatusLabelMap[signer.status]}
                          </span>
                          {signer.statusDateLabel ? (
                            <p className="text-xs text-(--tertiary)">
                              {signer.statusDateLabel}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        {signer.metaLabel}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </article>

        <article className="editorial-panel p-6 sm:p-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-[-0.03em] text-(--fg)">
              Timeline
            </h2>
            <span className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
              {activeRecord.timeline.length} events
            </span>
          </div>

          <ol className="mt-5 space-y-5">
            {activeRecord.timeline.map((event, index) => (
              <li className="relative pl-6" key={event.id}>
                <span
                  aria-hidden="true"
                  className={`absolute left-0 top-2.5 size-2.5 rounded-full ${timelineToneClasses[event.tone]}`}
                />
                {index < activeRecord.timeline.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute left-[4.5px] top-5 h-[calc(100%+0.875rem)] w-px bg-(--border)"
                  />
                ) : null}
                <p className="text-sm font-semibold text-(--fg)">
                  {event.timestamp}
                </p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {event.description}
                </p>
              </li>
            ))}
          </ol>
        </article>
      </section>

      <section className="editorial-panel p-6 sm:p-8">
        <h2 className="text-lg font-semibold tracking-[-0.03em] text-(--fg)">
          Actions
        </h2>

        <div className="mt-5 flex flex-wrap gap-3">
          {activeRecord.status === "draft" ? (
            <>
              <ShellButton href={`/envelopes/${envelopeId}/prepare`}>
                Continue editing
              </ShellButton>
              <ShellButton
                onClick={() => setActiveModal("delete-draft")}
                variant="secondary"
              >
                Delete draft
              </ShellButton>
            </>
          ) : null}

          {activeRecord.status === "sent" ? (
            <>
              <ShellButton
                disabled={!activeSigner || reminderLimited}
                loading={isSendingReminder}
                onClick={handleSendReminder}
              >
                Send reminder
              </ShellButton>
              <ShellButton
                onClick={() => setActiveModal("void-envelope")}
                variant="secondary"
              >
                Void envelope
              </ShellButton>
            </>
          ) : null}

          {activeRecord.status === "completed" ? (
            <>
              <ShellButton onClick={() => handleDownload("signed")}>
                Download signed PDF
              </ShellButton>
              <ShellButton
                onClick={() => handleDownload("evidence")}
                variant="secondary"
              >
                Download certificate
              </ShellButton>
            </>
          ) : null}

          {activeRecord.status === "declined" ||
          activeRecord.status === "voided" ? (
            <ShellButton onClick={() => handleDownload("evidence")}>
              Download certificate
            </ShellButton>
          ) : null}
        </div>

        {reminderHelperText ? (
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            {reminderHelperText}
          </p>
        ) : null}
      </section>

      {activeModal === "delete-draft" ? (
        <ConfirmationDialog
          confirmLabel="Delete draft"
          description={[
            "This draft has not been sent yet.",
            "Deleting it will permanently remove the draft and its placed fields.",
          ]}
          errorMessage={actionError}
          onCancel={() => setActiveModal(null)}
          onConfirm={handleConfirmDeleteDraft}
          processing={isDeletingDraft}
          title="Delete this draft?"
        />
      ) : null}

      {activeModal === "void-envelope" ? (
        <ConfirmationDialog
          confirmLabel="Void envelope"
          description={[
            "This will cancel the signing process.",
            "Notified signers will be informed that the envelope has been voided.",
            "This action cannot be undone.",
          ]}
          errorMessage={actionError}
          onCancel={() => setActiveModal(null)}
          onConfirm={handleConfirmVoidEnvelope}
          processing={isVoidingEnvelope}
          title="Void this envelope?"
        />
      ) : null}
    </div>
  );
}

type ConfirmationDialogProps = {
  confirmLabel: string;
  description: readonly string[];
  errorMessage?: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  processing?: boolean;
  title: string;
};

function ConfirmationDialog({
  confirmLabel,
  description,
  errorMessage,
  onCancel,
  onConfirm,
  processing = false,
  title,
}: ConfirmationDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !processing) {
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
              {title}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm leading-6 text-muted-foreground">
                {description.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </DialogDescription>
          </DialogHeader>

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
              disabled={processing}
              onClick={onCancel}
              variant="secondary"
            >
              Cancel
            </ShellButton>
            <ShellButton loading={processing} onClick={onConfirm}>
              {processing ? `${confirmLabel}...` : confirmLabel}
            </ShellButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
