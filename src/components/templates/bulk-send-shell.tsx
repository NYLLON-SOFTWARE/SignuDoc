"use client";

import Link from "next/link";
import { useRef, useState, type ChangeEvent } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StatusPanel } from "@/components/shared/status-panel";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type BulkSendBatchKey,
  type BulkSendResult,
  type BulkSendRowResult,
  bulkSendBatchKeyForCheck,
  bulkSendPreviewKey,
  copyRecipientPairError,
  serializeBulkSendResultsCsv,
} from "@/lib/bulk-send-csv";
import { PERMITTED_USE_PATH } from "@/lib/permitted-uses";
import {
  FIXED_REMINDER_SCHEDULE,
  formatReminderInterval,
  parseReminderSelection,
  type ReminderSelection,
  reminderSelectionOptions,
} from "@/lib/services/reminders";
import { SIGNATURE_MEANING_DETAILS } from "@/lib/signature-meanings";
import type { UseTemplateData } from "@/lib/templates";
import {
  DEFAULT_ENVELOPE_DEADLINE_DAYS,
  DEFAULT_ENVELOPE_REMINDER_DAYS,
  ENVELOPE_DEADLINE_DAY_OPTIONS,
  ENVELOPE_REMINDER_DAY_OPTIONS,
  signatureMeanings,
  type SignatureMeaning,
} from "@/lib/types/domain";

type BulkSendRequest = {
  copyRecipients: { email: string; name: string }[] | undefined;
  csv: string;
  expiresInDays: number;
  reminderIntervalDays: number | null;
  requireEmailCode: boolean;
  signatureMeaning: SignatureMeaning | null;
};

type BulkSendShellProps = {
  errorMessage?: string;
  exampleCsv: string;
  maxRows: number;
  part11Mode?: boolean;
  template?: UseTemplateData;
};

const genericError = "Something went wrong. Please try again.";

function statusPill(status: BulkSendRowResult["status"]) {
  if (status === "sent" || status === "ok") {
    return "pill pill-success";
  }

  if (status === "failed") {
    return "pill pill-danger";
  }

  return "pill pill-warning";
}

function statusLabel(status: BulkSendRowResult["status"]) {
  if (status === "ok") {
    return "Ready";
  }

  if (status === "sent") {
    return "Sent";
  }

  if (status === "failed") {
    return "Failed";
  }

  return "Skipped";
}

function downloadResults(
  result: BulkSendResult,
  roleNames: readonly string[],
  templateName: string,
) {
  const csv = serializeBulkSendResultsCsv(result.rows, roleNames);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `${templateName.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "bulk-send"}-results.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function newBulkSendBatchKey(): string {
  return crypto.randomUUID();
}

function csvColumnHelp(roleNames: readonly string[]): string {
  if (roleNames.length === 1) {
    return "For this template the header is name,email. You can add a title column. Each row becomes its own envelope.";
  }

  return `For this template name the columns after each signer: ${roleNames
    .map((name) => `${name} name, ${name} email`)
    .join("; ")}. A title column is optional.`;
}

export function BulkSendShell({
  errorMessage,
  exampleCsv,
  maxRows,
  part11Mode = false,
  template,
}: BulkSendShellProps) {
  const [csv, setCsv] = useState("");
  const [deadlineDays, setDeadlineDays] = useState(
    DEFAULT_ENVELOPE_DEADLINE_DAYS,
  );
  const [reminderDays, setReminderDays] = useState<ReminderSelection>(
    DEFAULT_ENVELOPE_REMINDER_DAYS,
  );
  const [copyName, setCopyName] = useState("");
  const [copyEmail, setCopyEmail] = useState("");
  const batchKeyRef = useRef<BulkSendBatchKey>({
    key: newBulkSendBatchKey(),
    requestKey: null,
  });
  const [requireEmailCode, setRequireEmailCode] = useState(false);
  const [signatureMeaning, setSignatureMeaning] = useState<
    SignatureMeaning | ""
  >("");
  // The preview is only valid for the exact inputs that were checked, so it
  // is stored with the request it came from and sending reuses that request.
  const [checked, setChecked] = useState<{
    key: string;
    preview: BulkSendResult;
    request: BulkSendRequest;
  } | null>(null);
  const [results, setResults] = useState<BulkSendResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!template) {
    return (
      <div className="space-y-5">
        <PageHeader title="Send to many" />
        <StatusPanel
          action={{ href: "/templates", label: "Back to templates" }}
          description={
            errorMessage ??
            "We couldn't load this template. Try again in a moment."
          }
          title="This template can't be used"
          tone="error"
        />
      </div>
    );
  }

  const current = template;
  const roleNames = current.roles.map((role) => role.name);
  const copyError = copyRecipientPairError(copyName, copyEmail);
  const copyRecipients =
    copyError === null &&
    copyName.trim().length > 0 &&
    copyEmail.trim().length > 0
      ? [{ email: copyEmail, name: copyName }]
      : [];
  const requestBody: BulkSendRequest = {
    copyRecipients: copyRecipients.length > 0 ? copyRecipients : undefined,
    csv,
    expiresInDays: deadlineDays,
    ...reminderSelectionOptions(reminderDays),
    requireEmailCode,
    signatureMeaning: signatureMeaning || null,
  };
  const requestKey = bulkSendPreviewKey({
    copyEmail,
    copyName,
    csv,
    expiresInDays: deadlineDays,
    ...reminderSelectionOptions(reminderDays),
    requireEmailCode,
    signatureMeaning: signatureMeaning || null,
  });
  // A check that finishes after the inputs changed describes a different
  // batch, so it is ignored until the list is checked again.
  const preview =
    checked && checked.key === requestKey ? checked.preview : null;

  async function postBulkSend(
    request: BulkSendRequest,
    confirm: boolean,
    permittedUseConfirmed = false,
  ) {
    const response = await fetch(`/api/templates/${current.id}/bulk-send`, {
      body: JSON.stringify({
        ...request,
        batchKey: confirm ? batchKeyRef.current.key : undefined,
        confirm,
        permittedUseConfirmed,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json().catch(() => null)) as
      (BulkSendResult & { error?: string }) | { error?: string } | null;

    if (!response.ok) {
      throw new Error(payload?.error ?? genericError);
    }

    if (!payload || !("rows" in payload) || !Array.isArray(payload.rows)) {
      throw new Error(genericError);
    }

    return payload;
  }

  async function handleCheck() {
    if (isChecking || isSending || csv.trim().length === 0) {
      return;
    }

    if (copyError) {
      setActionError(copyError);
      return;
    }

    setActionError(null);
    setResults(null);
    setIsChecking(true);

    const request = requestBody;
    const key = requestKey;

    try {
      const checkedPreview = await postBulkSend(request, false);

      batchKeyRef.current = bulkSendBatchKeyForCheck(
        batchKeyRef.current,
        key,
        newBulkSendBatchKey,
      );
      setChecked({
        key,
        preview: checkedPreview,
        request,
      });
    } catch (error) {
      setChecked(null);
      setActionError(error instanceof Error ? error.message : genericError);
    } finally {
      setIsChecking(false);
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    event.target.value = "";

    if (!file) {
      return;
    }

    const text = await file.text();

    setCsv(text);
    setChecked(null);
    setResults(null);
    setActionError(null);
  }

  async function handleConfirmSend() {
    if (isSending || !checked || !preview || preview.summary.ok === 0) {
      return;
    }

    setActionError(null);
    setIsSending(true);

    try {
      const sent = await postBulkSend(checked.request, true, true);

      setResults(sent);
      setChecked(null);
      setIsConfirming(false);
      batchKeyRef.current = {
        key: newBulkSendBatchKey(),
        requestKey: null,
      };
    } catch (error) {
      setActionError(error instanceof Error ? error.message : genericError);
    } finally {
      setIsSending(false);
    }
  }

  const readyCount = preview?.summary.ok ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        description={`${template.name} · ${template.pageCountLabel} · ${template.fieldCountLabel}`}
        title="Send to many"
      />

      {results ? (
        <section className="panel space-y-5 p-5 sm:p-8" data-animate="enter">
          <div className="space-y-1">
            <h2 className="text-lg font-extrabold text-(--fg)">Results</h2>
            <p className="text-sm leading-6 text-(--secondary)">
              {results.summary.sent} sent
              {results.summary.skipped > 0
                ? ` · ${String(results.summary.skipped)} skipped`
                : ""}
              {results.summary.failed > 0
                ? ` · ${String(results.summary.failed)} failed`
                : ""}
              . Each sent envelope is independent.
            </p>
          </div>
          <RowTable result={results} roleNames={roleNames} />
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <ShellButton href="/dashboard" variant="secondary">
              Go to documents
            </ShellButton>
            <ShellButton
              onClick={() => downloadResults(results, roleNames, current.name)}
              variant="secondary"
            >
              Download results CSV
            </ShellButton>
            <ShellButton
              onClick={() => {
                batchKeyRef.current = {
                  key: newBulkSendBatchKey(),
                  requestKey: null,
                };
                setResults(null);
                setChecked(null);
                setActionError(null);
              }}
            >
              Send another batch
            </ShellButton>
          </div>
        </section>
      ) : (
        <form
          className="panel space-y-6 p-5 sm:p-8"
          data-animate="enter"
          data-animate-delay="1"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCheck();
          }}
        >
          <div className="space-y-2">
            <h2 className="text-lg font-extrabold text-(--fg)">
              Who should sign?
            </h2>
            <p className="text-sm leading-6 text-(--secondary)">
              Upload a CSV or paste it below. {csvColumnHelp(roleNames)} A batch
              can send at most {String(maxRows)} envelopes. Nothing is created
              until you confirm.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="btn-quiet cursor-pointer">
              Upload a CSV
              <input
                accept=".csv,text/csv,text/plain"
                aria-label="Upload a CSV"
                className="sr-only"
                onChange={(event) => {
                  void handleFile(event);
                }}
                type="file"
              />
            </label>
            <button
              className="btn-quiet"
              onClick={() => {
                setCsv(exampleCsv);
                setChecked(null);
                setResults(null);
                setActionError(null);
              }}
              type="button"
            >
              Use the example
            </button>
          </div>

          <label className="grid gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-(--secondary)">
              CSV
            </span>
            <textarea
              aria-label="People who should sign"
              className="field-input min-h-40 font-mono text-[0.8125rem] leading-6"
              onChange={(event) => {
                setCsv(event.target.value);
                setChecked(null);
                setActionError(null);
              }}
              spellCheck={false}
              value={csv}
            />
          </label>

          <div className="well space-y-4 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                  Signing deadline
                </span>
                <select
                  className="field-input"
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
                  onChange={(event) =>
                    setReminderDays(parseReminderSelection(event.target.value))
                  }
                  value={reminderDays ?? "off"}
                >
                  <option value="off">{formatReminderInterval(null)}</option>
                  <option value={FIXED_REMINDER_SCHEDULE}>
                    {formatReminderInterval(FIXED_REMINDER_SCHEDULE)}
                  </option>
                  {ENVELOPE_REMINDER_DAY_OPTIONS.map((days) => (
                    <option key={days} value={days}>
                      {formatReminderInterval(days)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-sm leading-6 text-(--secondary)">
              Every envelope in the batch gets the same deadline, reminders,
              copy recipient and extra check. Consent and the audit trail are
              the same as a hand-sent envelope.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                  Copy recipient name
                </span>
                <input
                  className="field-input"
                  maxLength={120}
                  onChange={(event) => setCopyName(event.target.value)}
                  placeholder="Optional"
                  type="text"
                  value={copyName}
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                  Copy recipient email
                </span>
                <input
                  className="field-input"
                  maxLength={320}
                  onChange={(event) => setCopyEmail(event.target.value)}
                  placeholder="Optional"
                  type="email"
                  value={copyEmail}
                />
              </label>
            </div>
            {copyError ? (
              <p className="notice notice-danger" role="alert">
                {copyError}
              </p>
            ) : null}
            <label className="flex items-start gap-3 text-sm leading-6 text-(--secondary)">
              <Checkbox
                checked={requireEmailCode}
                className="mt-1"
                onCheckedChange={(checked) =>
                  setRequireEmailCode(checked === true)
                }
              />
              Email a one-time code when each signer opens the link
            </label>
            {part11Mode ? (
              <label className="grid max-w-md gap-1.5">
                <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                  What each signature means
                </span>
                <select
                  className="field-input"
                  onChange={(event) =>
                    setSignatureMeaning(
                      event.target.value as SignatureMeaning | "",
                    )
                  }
                  value={signatureMeaning}
                >
                  <option value="">Choose one</option>
                  {signatureMeanings.map((meaning) => (
                    <option key={meaning} value={meaning}>
                      {SIGNATURE_MEANING_DETAILS[meaning].label}
                    </option>
                  ))}
                </select>
                <span className="text-sm leading-6 text-(--secondary)">
                  Part 11 mode only lets people sign with a verified account
                  whose identity an administrator has confirmed. Rows that do
                  not meet that are skipped, with the reason.
                </span>
              </label>
            ) : null}
          </div>

          {actionError ? (
            <div className="notice notice-danger" role="alert">
              <p>{actionError}</p>
            </div>
          ) : null}

          {preview ? (
            <div className="space-y-3">
              <p className="text-sm leading-6 text-(--secondary)">
                {readyCount} {readyCount === 1 ? "envelope" : "envelopes"} can
                be sent
                {preview.summary.skipped > 0
                  ? ` · ${String(preview.summary.skipped)} skipped`
                  : ""}
                . Check the table before confirming.
              </p>
              <RowTable result={preview} roleNames={roleNames} />
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <ShellButton href="/templates" variant="secondary">
              Cancel
            </ShellButton>
            <ShellButton
              disabled={csv.trim().length === 0 || Boolean(copyError)}
              loading={isChecking}
              type="submit"
              variant="secondary"
            >
              {isChecking ? "Checking..." : "Check this list"}
            </ShellButton>
            <ShellButton
              disabled={
                !preview || readyCount === 0 || isChecking || Boolean(copyError)
              }
              onClick={() => {
                setActionError(null);
                setIsConfirming(true);
              }}
            >
              {readyCount > 0
                ? `Send ${String(readyCount)} ${readyCount === 1 ? "envelope" : "envelopes"}`
                : "Send envelopes"}
            </ShellButton>
          </div>
        </form>
      )}

      {isConfirming && preview ? (
        <SendManyDialog
          errorMessage={actionError}
          isSending={isSending}
          onCancel={() => {
            if (!isSending) {
              setIsConfirming(false);
            }
          }}
          onConfirm={() => {
            void handleConfirmSend();
          }}
          readyCount={readyCount}
          skippedCount={preview.summary.skipped}
          templateName={current.name}
        />
      ) : null}
    </div>
  );
}

function RowTable({
  result,
  roleNames,
}: {
  result: BulkSendResult;
  roleNames: readonly string[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-separate border-spacing-y-2 text-left text-sm">
        <caption className="sr-only">
          {result.summary.sent > 0 ? "Bulk send results" : "Bulk send preview"}
        </caption>
        <thead>
          <tr className="text-[0.8125rem] text-(--secondary)">
            <th className="px-3 py-1 font-semibold">Row</th>
            <th className="px-3 py-1 font-semibold">Status</th>
            {roleNames.map((name) => (
              <th className="px-3 py-1 font-semibold" key={name}>
                {name}
              </th>
            ))}
            <th className="px-3 py-1 font-semibold">Title</th>
            <th className="px-3 py-1 font-semibold">Notes</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr className="well" key={row.rowNumber}>
              <td className="rounded-l-xl px-3 py-3 font-semibold">
                {row.rowNumber}
              </td>
              <td className="px-3 py-3">
                <span className={statusPill(row.status)}>
                  {statusLabel(row.status)}
                </span>
              </td>
              {row.signers.map((signer) => (
                <td className="px-3 py-3" key={signer.roleName}>
                  <span className="block font-semibold text-(--fg)">
                    {signer.name || "—"}
                  </span>
                  <span className="block text-(--secondary)">
                    {signer.email || "—"}
                  </span>
                </td>
              ))}
              <td className="px-3 py-3">{row.title}</td>
              <td className="rounded-r-xl px-3 py-3">
                {row.envelopePath ? (
                  <Link
                    className="font-semibold text-(--accent-ink) underline-offset-4 hover:underline"
                    href={row.envelopePath}
                  >
                    Open envelope
                  </Link>
                ) : null}
                {row.reason ? (
                  <p className="text-(--secondary)">{row.reason}</p>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SendManyDialog({
  errorMessage,
  isSending,
  onCancel,
  onConfirm,
  readyCount,
  skippedCount,
  templateName,
}: {
  errorMessage: string | null;
  isSending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  readyCount: number;
  skippedCount: number;
  templateName: string;
}) {
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
            <DialogTitle>Send these envelopes?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm leading-6 text-(--secondary)">
                <p>
                  &quot;{templateName}&quot; will be sent as {readyCount}{" "}
                  {readyCount === 1 ? "envelope" : "envelopes"}
                  {skippedCount > 0
                    ? `, and ${String(skippedCount)} ${skippedCount === 1 ? "row" : "rows"} will be skipped`
                    : ""}
                  . Each envelope is sent on its own, so one failure does not
                  take the others with it.
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
                By sending, you confirm these documents are ordinary business
                agreements and not a will, court order, legally required
                consumer disclosure, or other{" "}
                <a
                  className="font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4"
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
