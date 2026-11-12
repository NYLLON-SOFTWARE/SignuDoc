"use client";

import { DownloadIcon } from "lucide-react";
import Image from "next/image";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  PdfPageCanvas,
  type PdfPageRenderState,
} from "@/components/envelopes/pdf-page-canvas";
import { Brand } from "@/components/layout/brand";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@/components/layout/nav-items";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import {
  beginDocumentPanGesture,
  clampDocumentZoomLevel,
  DEFAULT_DOCUMENT_ZOOM_LEVEL,
  DocumentZoomControls,
  endDocumentPanGesture,
  moveDocumentPanGesture,
  type DocumentPanGesture,
  DOCUMENT_ZOOM_STEP,
} from "@/components/shared/document-viewport";
import { ShellButton } from "@/components/shared/form-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  type SigningCurrentField,
  type SigningPayload,
  type SigningVisibleField,
} from "@/lib/schemas/signing";
import { type SigningSubmission } from "@/lib/schemas/field";

const typedSignatureFont =
  '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive';

type SignatureEntry = {
  imageDataUrl?: string | null;
  inputMethod: "drawn" | "typed";
  value: string;
};

type SignatureModalState = {
  fieldId: string;
  mode: "drawn" | "typed";
  type: "initials" | "signature";
};

type ReusableSignatureEntries = Record<
  SignatureModalState["type"],
  SignatureEntry | null
>;

type PositionedSigningField = {
  height: string;
  left: string;
  top: string;
  width: string;
};

const defaultSubmitErrorMessage =
  "We couldn't finish signing right now. Reload the page or request a fresh signing link from the sender.";
const defaultDeclineErrorMessage =
  "We couldn't record your decline right now. Reload the page or request a fresh signing link from the sender.";
const compactFieldHeightThreshold = 0.045;
const compactFieldWidthThreshold = 0.12;

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 4)
    .toUpperCase();
}

function getFieldFrame(field: SigningCurrentField | SigningVisibleField) {
  return {
    height: `${field.height * 100}%`,
    left: `${field.x * 100}%`,
    top: `${field.y * 100}%`,
    width: `${field.width * 100}%`,
  } satisfies PositionedSigningField;
}

function shouldShowInlineFieldLabel(
  field: Pick<SigningCurrentField | SigningVisibleField, "height" | "width">,
) {
  return (
    field.width >= compactFieldWidthThreshold &&
    field.height >= compactFieldHeightThreshold
  );
}

function shouldShowInlineFieldValue(
  field: Pick<SigningCurrentField | SigningVisibleField, "height" | "width">,
) {
  return field.width >= 0.08 && field.height >= 0.03;
}

function getCanvasFieldLabel(
  field: Pick<SigningCurrentField | SigningVisibleField, "label" | "type">,
) {
  if (field.label?.trim()) {
    return field.label;
  }

  switch (field.type) {
    case "signature":
      return "Sign";
    case "initials":
      return "Initial";
    case "date":
      return "Date";
    case "text":
      return "Text";
    case "checkbox":
      return "Checkbox";
    default:
      return "Field";
  }
}

function getSignatureFieldType(
  field: Pick<SigningCurrentField, "type">,
): SignatureModalState["type"] | null {
  if (field.type === "initials" || field.type === "signature") {
    return field.type;
  }

  return null;
}

function getFieldLabel(
  field: Pick<SigningCurrentField, "label" | "type">,
): string {
  if (field.label?.trim()) {
    return field.label;
  }

  switch (field.type) {
    case "signature":
      return "Sign here";
    case "initials":
      return "Initial here";
    case "date":
      return "Date";
    case "text":
      return "Enter text";
    case "checkbox":
      return "Checkbox";
    default:
      return "Field";
  }
}

function getSummaryLabel(field: SigningCurrentField) {
  switch (field.type) {
    case "signature":
      return "Signature";
    case "initials":
      return "Initials";
    case "date":
      return "Date";
    case "text":
      return "Text input";
    case "checkbox":
      return "Checkbox";
    default:
      return "Field";
  }
}

function isActionSummaryField(field: SigningCurrentField) {
  if (field.type === "signature" || field.type === "initials") {
    return true;
  }

  if (field.type === "text") {
    return true;
  }

  if (field.type === "checkbox") {
    return field.required;
  }

  return false;
}

function getCompletionValue(
  field: SigningCurrentField,
  {
    checkboxValues,
    localDateLabel,
    signatureValues,
    textValues,
  }: {
    checkboxValues: Record<string, boolean>;
    localDateLabel: string;
    signatureValues: Record<string, SignatureEntry>;
    textValues: Record<string, string>;
  },
) {
  if (field.type === "signature" || field.type === "initials") {
    return signatureValues[field.id]?.value ?? "Tap to sign";
  }

  if (field.type === "text") {
    return textValues[field.id]?.trim() || "Enter text";
  }

  if (field.type === "checkbox") {
    return checkboxValues[field.id] ? "Checked" : "Optional";
  }

  return localDateLabel;
}

function isFieldComplete(
  field: SigningCurrentField,
  {
    checkboxValues,
    signatureValues,
    textValues,
  }: {
    checkboxValues: Record<string, boolean>;
    signatureValues: Record<string, SignatureEntry>;
    textValues: Record<string, string>;
  },
) {
  if (field.type === "signature" || field.type === "initials") {
    return Boolean(signatureValues[field.id]?.value);
  }

  if (field.type === "text") {
    if (!field.required) {
      return true;
    }

    return (textValues[field.id] ?? "").trim().length > 0;
  }

  if (field.type === "checkbox") {
    if (!field.required) {
      return true;
    }

    return Boolean(checkboxValues[field.id]);
  }

  return true;
}

function getVisibleFieldValue(field: SigningVisibleField) {
  if (field.type === "checkbox") {
    return field.checked ? "Checked" : "Unchecked";
  }

  return field.value?.trim() || getFieldLabel(field);
}

function buildSigningSubmissionPayload(
  record: SigningPayload,
  {
    checkboxValues,
    signatureValues,
    textValues,
  }: {
    checkboxValues: Record<string, boolean>;
    signatureValues: Record<string, SignatureEntry>;
    textValues: Record<string, string>;
  },
): SigningSubmission {
  const fields: SigningSubmission["fields"] = [];

  for (const field of record.currentSignerFields) {
    if (field.type === "signature" || field.type === "initials") {
      const entry = signatureValues[field.id];

      if (!entry) {
        continue;
      }

      if (entry.inputMethod === "drawn" && entry.imageDataUrl) {
        fields.push({
          fieldId: field.id,
          imageDataUrl: entry.imageDataUrl,
          inputMethod: "drawn",
          type: field.type,
        });
        continue;
      }

      fields.push({
        fieldId: field.id,
        inputMethod: "typed",
        type: field.type,
        value: entry.value,
      });
      continue;
    }

    if (field.type === "text") {
      const value = textValues[field.id]?.trim();

      if (value) {
        fields.push({
          fieldId: field.id,
          type: "text",
          value,
        });
      }

      continue;
    }

    if (field.type === "checkbox") {
      fields.push({
        checked: Boolean(checkboxValues[field.id]),
        fieldId: field.id,
        type: "checkbox",
      });
    }
  }

  return {
    clientTimezoneOffsetMinutes: new Date().getTimezoneOffset(),
    fields,
  };
}

export function SigningLiveShell({ record }: { record: SigningPayload }) {
  const [activePage, setActivePage] = useState(
    record.currentSignerFields[0]?.page ??
      record.visibleFields[0]?.page ??
      record.pages[0]?.pageNumber ??
      1,
  );
  const [checkboxValues, setCheckboxValues] = useState<Record<string, boolean>>(
    {},
  );
  const [consentedAt, setConsentedAt] = useState(record.consentedAt);
  const [isConsentChecked, setIsConsentChecked] = useState(false);
  const [isSavingConsent, setIsSavingConsent] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [declineError, setDeclineError] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  const [isDeclineDialogOpen, setIsDeclineDialogOpen] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const [isFinishDialogOpen, setIsFinishDialogOpen] = useState(false);
  const [isDocumentPanning, setIsDocumentPanning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pdfRenderState, setPdfRenderState] =
    useState<PdfPageRenderState>("loading");
  const [signatureValues, setSignatureValues] = useState<
    Record<string, SignatureEntry>
  >({});
  const [reusableSignatureEntries, setReusableSignatureEntries] =
    useState<ReusableSignatureEntries>({
      initials: null,
      signature: null,
    });
  const [signatureModal, setSignatureModal] =
    useState<SignatureModalState | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const [drawnSignatureVersion, setDrawnSignatureVersion] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_DOCUMENT_ZOOM_LEVEL);
  const [localDateLabel] = useState(() =>
    new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date()),
  );
  const paperGridRef = useRef<HTMLDivElement | null>(null);
  const documentPanGestureRef = useRef<DocumentPanGesture | null>(null);

  const activePageRecord =
    record.pages.find((page) => page.pageNumber === activePage) ??
    record.pages[0];
  const pageCurrentFields = record.currentSignerFields.filter(
    (field) => field.page === activePage,
  );
  const pageVisibleFields = record.visibleFields.filter(
    (field) => field.page === activePage,
  );
  const actionSummaryFields =
    record.currentSignerFields.filter(isActionSummaryField);
  const remainingFields = record.currentSignerFields.filter(
    (field) =>
      field.required &&
      !isFieldComplete(field, {
        checkboxValues,
        signatureValues,
        textValues,
      }),
  ).length;
  const canFinish = remainingFields === 0;
  const requiredFieldCount = record.currentSignerFields.filter(
    (field) => field.required,
  ).length;
  const completionPercent =
    requiredFieldCount === 0
      ? 100
      : Math.round(
          ((requiredFieldCount - remainingFields) / requiredFieldCount) * 100,
        );
  const isDocumentReady = pdfRenderState === "ready";

  function applyZoomLevel(nextZoomLevel: number) {
    if (nextZoomLevel <= DEFAULT_DOCUMENT_ZOOM_LEVEL) {
      setIsDocumentPanning(false);
      documentPanGestureRef.current = null;
    }

    setZoomLevel(nextZoomLevel);
  }

  function handleSignatureFieldClick(field: SigningCurrentField) {
    const fieldType = getSignatureFieldType(field);

    if (!fieldType) {
      return;
    }

    const existingFieldEntry = signatureValues[field.id];
    const reusableEntry = reusableSignatureEntries[fieldType];

    setDrawnSignatureVersion(0);
    setSubmitError(null);

    if (!existingFieldEntry && reusableEntry) {
      setSignatureValues((current) => ({
        ...current,
        [field.id]: reusableEntry,
      }));
      return;
    }

    setSignatureModal({
      fieldId: field.id,
      mode:
        existingFieldEntry?.inputMethod ??
        reusableEntry?.inputMethod ??
        "typed",
      type: fieldType,
    });
  }

  async function handleFinishSigning() {
    if (!canFinish || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const response = await fetch(record.submitUrl, {
        body: JSON.stringify(
          buildSigningSubmissionPayload(record, {
            checkboxValues,
            signatureValues,
            textValues,
          }),
        ),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectPath?: string;
        state?: string;
      } | null;

      if (!response.ok) {
        if (payload?.state) {
          window.location.reload();
          return;
        }

        setSubmitError(payload?.error ?? defaultSubmitErrorMessage);
        setIsSubmitting(false);
        return;
      }

      const fallbackRedirectPath = `${window.location.pathname.replace(/\/$/, "")}/done?title=${encodeURIComponent(record.envelopeTitle)}`;

      window.location.assign(payload?.redirectPath ?? fallbackRedirectPath);
    } catch {
      setSubmitError(defaultSubmitErrorMessage);
      setIsSubmitting(false);
    }
  }

  async function handleConsent() {
    setIsSavingConsent(true);
    setConsentError(null);

    try {
      const response = await fetch(record.consentUrl, {
        body: JSON.stringify({ disclosureVersion: record.disclosure.version }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        consentedAt?: number;
        error?: string;
      } | null;

      if (!response.ok || typeof payload?.consentedAt !== "number") {
        setConsentError(
          payload?.error ?? "Your agreement could not be saved right now.",
        );
        return;
      }

      setConsentedAt(payload.consentedAt);
    } catch {
      setConsentError("Your agreement could not be saved right now.");
    } finally {
      setIsSavingConsent(false);
    }
  }

  async function handleDeclineSigning() {
    if (isDeclining) {
      return;
    }

    setIsDeclining(true);
    setDeclineError(null);

    try {
      const response = await fetch(record.declineUrl, {
        body: JSON.stringify({
          reason: declineReason,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        state?: string;
      } | null;

      if (!response.ok) {
        if (payload?.state) {
          window.location.reload();
          return;
        }

        setDeclineError(payload?.error ?? defaultDeclineErrorMessage);
        setIsDeclining(false);
        return;
      }

      window.location.reload();
    } catch {
      setDeclineError(defaultDeclineErrorMessage);
      setIsDeclining(false);
    }
  }

  function beginDocumentPan(event: ReactPointerEvent<HTMLDivElement>) {
    documentPanGestureRef.current = beginDocumentPanGesture({
      event,
      scrollContainer: paperGridRef.current,
      shouldIgnoreTarget: (target) =>
        Boolean(target.closest("[data-signing-field='true']")),
      zoomLevel,
    });
  }

  function handleDocumentPanMove(event: ReactPointerEvent<HTMLDivElement>) {
    moveDocumentPanGesture({
      event,
      gesture: documentPanGestureRef.current,
      onPanStart: () => setIsDocumentPanning(true),
      scrollContainer: paperGridRef.current,
    });
  }

  function endDocumentPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      endDocumentPanGesture({
        event,
        gesture: documentPanGestureRef.current,
        onPanEnd: () => setIsDocumentPanning(false),
        scrollContainer: paperGridRef.current,
      })
    ) {
      documentPanGestureRef.current = null;
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 bg-[rgba(243,244,248,0.88)] backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[1320px] items-center justify-between gap-4 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-5">
            <Brand href="/" />
            <div className="hidden min-w-0 border-l border-(--border-strong) pl-5 sm:block">
              <p className="truncate text-sm font-bold text-(--fg)">
                {record.envelopeTitle}
              </p>
              <p className="mt-0.5 truncate text-[0.8125rem] text-(--tertiary)">
                From {record.senderName}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              className="btn-quiet min-h-11 px-3 sm:px-4"
              download="document.pdf"
              href={`${record.documentUrl}?download=1`}
            >
              <DownloadIcon aria-hidden="true" className="size-4" />
              <span className="sr-only sm:not-sr-only">Download PDF</span>
            </a>
            <ShellButton
              className="min-h-11 px-4"
              disabled={isSubmitting || isDeclining}
              onClick={() => {
                setDeclineError(null);
                setIsDeclineDialogOpen(true);
              }}
              variant="secondary"
            >
              Decline
            </ShellButton>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1320px] flex-1 flex-col gap-5 px-4 pb-8 pt-1 sm:px-6">
        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="panel rounded-[1.25rem] px-4 py-3">
              <div className="flex flex-col gap-3 xl:grid xl:grid-cols-[1fr_auto_1fr] xl:items-center">
                <div className="flex justify-center xl:justify-start">
                  <DocumentZoomControls
                    onDecrease={() =>
                      applyZoomLevel(
                        clampDocumentZoomLevel(zoomLevel - DOCUMENT_ZOOM_STEP),
                      )
                    }
                    onIncrease={() =>
                      applyZoomLevel(
                        clampDocumentZoomLevel(zoomLevel + DOCUMENT_ZOOM_STEP),
                      )
                    }
                    onReset={() => applyZoomLevel(DEFAULT_DOCUMENT_ZOOM_LEVEL)}
                    zoomLevel={zoomLevel}
                  />
                </div>

                <div className="flex items-center justify-center gap-3">
                  <button
                    aria-label="Previous page"
                    className="btn-quiet size-10 px-0"
                    disabled={activePage === 1}
                    onClick={() =>
                      setActivePage((page) => Math.max(1, page - 1))
                    }
                    type="button"
                  >
                    <ChevronLeftIcon className="size-4" />
                  </button>
                  <div className="min-w-[7.5rem] text-center">
                    <p className="sr-only">Document page</p>
                    <p className="text-sm font-bold text-(--fg)">
                      {`Page ${activePage} of ${record.pageCount}`}
                    </p>
                  </div>
                  <button
                    aria-label="Next page"
                    className="btn-quiet size-10 px-0"
                    disabled={activePage === record.pageCount}
                    onClick={() =>
                      setActivePage((page) =>
                        Math.min(record.pageCount, page + 1),
                      )
                    }
                    type="button"
                  >
                    <ChevronRightIcon className="size-4" />
                  </button>
                </div>

                <div className="flex justify-center xl:justify-end">
                  <SigningToolbarStatus
                    hasLockedFields={pageVisibleFields.length > 0}
                    remainingFields={remainingFields}
                  />
                </div>
              </div>
            </div>

            <div className="panel overflow-hidden rounded-[1.25rem]">
              <div
                className={`relative overflow-auto p-3 sm:p-6 ${
                  zoomLevel > DEFAULT_DOCUMENT_ZOOM_LEVEL
                    ? isDocumentPanning
                      ? "cursor-grabbing"
                      : "cursor-grab"
                    : ""
                }`}
                data-paper-grid
                onPointerCancel={endDocumentPan}
                onPointerDown={beginDocumentPan}
                onPointerMove={handleDocumentPanMove}
                onPointerUp={endDocumentPan}
                ref={paperGridRef}
              >
                <div
                  className={`mx-auto ${
                    zoomLevel > DEFAULT_DOCUMENT_ZOOM_LEVEL
                      ? "w-full"
                      : "flex justify-center"
                  }`}
                >
                  <div
                    className="relative overflow-hidden rounded-md bg-white shadow-[0_1px_2px_rgba(28,29,43,0.08),0_12px_32px_rgba(28,29,43,0.12)]"
                    style={{
                      width: `${zoomLevel * 100}%`,
                    }}
                  >
                    <div
                      className="relative overflow-hidden"
                      data-field-viewport
                      style={{
                        aspectRatio: `${activePageRecord?.widthPt ?? 8.5} / ${activePageRecord?.heightPt ?? 11}`,
                      }}
                    >
                      <PdfPageCanvas
                        documentUrl={record.documentUrl}
                        onRenderStateChange={setPdfRenderState}
                        pageNumber={activePage}
                      />

                      {isDocumentReady
                        ? pageVisibleFields.map((field) => (
                            <VisibleFieldStamp field={field} key={field.id} />
                          ))
                        : null}

                      {isDocumentReady
                        ? pageCurrentFields.map((field) => (
                            <CurrentSignerField
                              checkboxValue={Boolean(checkboxValues[field.id])}
                              field={field}
                              key={field.id}
                              localDateLabel={localDateLabel}
                              onCheckboxChange={(checked) => {
                                setSubmitError(null);
                                setCheckboxValues((current) => ({
                                  ...current,
                                  [field.id]: checked,
                                }));
                              }}
                              onSignatureClick={() =>
                                handleSignatureFieldClick(field)
                              }
                              onTextChange={(value) => {
                                setSubmitError(null);
                                setTextValues((current) => ({
                                  ...current,
                                  [field.id]: value,
                                }));
                              }}
                              signatureEntry={signatureValues[field.id]}
                              textValue={textValues[field.id] ?? ""}
                            />
                          ))
                        : null}

                      {isDocumentReady &&
                      pageCurrentFields.length === 0 &&
                      pageVisibleFields.length === 0 ? (
                        <div className="absolute inset-0 z-1 flex items-center justify-center px-6">
                          <div className="max-w-[320px] rounded-[1.25rem] border-2 border-dashed border-(--border-strong) bg-white/92 px-6 py-7 text-center">
                            <p className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                              No signer fields on this page
                            </p>
                            <p className="mt-2 text-sm leading-6 text-(--secondary)">
                              Move between pages to review your assigned fields
                              and any completed values from earlier signers.
                            </p>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside className="space-y-4 xl:sticky xl:top-[5.25rem] xl:self-start">
            <section className="panel rounded-[1.25rem] p-5">
              <p className="section-eyebrow">Current signer</p>
              <div className="mt-3 flex items-center gap-3">
                <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-(--accent-soft) text-[0.9375rem] font-bold text-(--accent-ink)">
                  {getInitials(record.signer.name)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[0.9375rem] font-bold text-(--fg)">
                    {record.signer.name}
                  </p>
                  <p className="truncate text-sm text-(--secondary)">
                    {record.signer.email}
                  </p>
                </div>
              </div>

              <div className="well mt-5 p-4">
                <p className="section-eyebrow">Ready to finish</p>
                <p className="mt-1.5 text-[0.9375rem] font-bold text-(--fg)">
                  {remainingFields === 0
                    ? "All required fields complete"
                    : `${remainingFields} required field${remainingFields === 1 ? "" : "s"} remaining`}
                </p>
                <div
                  aria-hidden="true"
                  className="mt-3 h-2 overflow-hidden rounded-full bg-(--surface-strong)"
                >
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${
                      remainingFields === 0 ? "bg-(--success)" : "bg-(--accent)"
                    }`}
                    style={{ width: `${completionPercent}%` }}
                  />
                </div>
                <p className="mt-3 text-[0.8125rem] leading-5 text-(--secondary)">
                  Previous signer values stay visible but locked. Only your
                  assigned fields are interactive.
                </p>
              </div>

              <div className="mt-4">
                <ShellButton
                  className="w-full"
                  disabled={!canFinish || isDeclining || isSubmitting}
                  onClick={() => {
                    setSubmitError(null);
                    setIsFinishDialogOpen(true);
                  }}
                >
                  Finish
                </ShellButton>
              </div>
            </section>

            <section className="panel rounded-[1.25rem] p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="section-eyebrow">Assigned fields</p>
                <span className="pill pill-neutral">
                  {actionSummaryFields.length}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {actionSummaryFields.map((field) => (
                  <FieldStatusRow
                    isComplete={isFieldComplete(field, {
                      checkboxValues,
                      signatureValues,
                      textValues,
                    })}
                    key={field.id}
                    label={`${getSummaryLabel(field)} · Page ${field.page}`}
                    value={getCompletionValue(field, {
                      checkboxValues,
                      localDateLabel,
                      signatureValues,
                      textValues,
                    })}
                  />
                ))}
              </div>
            </section>
          </aside>
        </section>
      </main>

      <PublicLegalFooter />

      {signatureModal ? (
        <SignatureModal
          existingEntry={
            signatureValues[signatureModal.fieldId] ??
            reusableSignatureEntries[signatureModal.type] ??
            undefined
          }
          drawnSignatureVersion={drawnSignatureVersion}
          fieldType={signatureModal.type}
          onApply={(entry) => {
            setReusableSignatureEntries((current) => ({
              ...current,
              [signatureModal.type]: entry,
            }));
            setSignatureValues((current) => ({
              ...current,
              [signatureModal.fieldId]: entry,
            }));
            setSubmitError(null);
            setSignatureModal(null);
          }}
          onClearDrawnSignature={() =>
            setDrawnSignatureVersion((current) => current + 1)
          }
          onClose={() => setSignatureModal(null)}
          onModeChange={(mode) =>
            setSignatureModal((current) =>
              current
                ? {
                    ...current,
                    mode,
                  }
                : null,
            )
          }
          signatureMode={signatureModal.mode}
          signerName={record.signer.name}
        />
      ) : null}

      {isFinishDialogOpen ? (
        <DialogFrame
          description={`You are signing "${record.envelopeTitle}" from ${record.senderName}.`}
          title="Finish signing?"
          onClose={() => {
            if (isSubmitting) {
              return;
            }

            setIsFinishDialogOpen(false);
            setSubmitError(null);
          }}
        >
          <p className="text-sm leading-6 text-(--secondary)">
            By clicking Finish, you confirm that your electronic signature is
            intended to be binding for this document.
          </p>
          {submitError ? (
            <div className="notice notice-danger" role="alert">
              {submitError}
            </div>
          ) : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <ShellButton
              disabled={isDeclining || isSubmitting}
              onClick={() => {
                setIsFinishDialogOpen(false);
                setSubmitError(null);
              }}
              variant="secondary"
            >
              Back
            </ShellButton>
            <ShellButton loading={isSubmitting} onClick={handleFinishSigning}>
              {isSubmitting ? "Finishing..." : "Finish signing"}
            </ShellButton>
          </div>
        </DialogFrame>
      ) : null}

      {consentedAt === null && !isDeclineDialogOpen ? (
        <DialogFrame
          description={`${record.senderName} sent you "${record.envelopeTitle}" to sign electronically.`}
          onClose={() => undefined}
          title="Before you sign"
        >
          <div className="well max-h-[45vh] space-y-4 overflow-y-auto px-4 py-4 text-sm leading-6 text-(--secondary) sm:px-5">
            {record.disclosure.sections.map((section) => (
              <section key={section.heading}>
                <h3 className="font-bold text-(--fg)">{section.heading}</h3>
                <p className="mt-1">{section.text}</p>
              </section>
            ))}
          </div>
          <label className="flex items-start gap-3 text-sm leading-6 text-(--fg)">
            <Checkbox
              aria-label="I agree to use electronic records and signatures"
              checked={isConsentChecked}
              className="mt-1"
              disabled={isSavingConsent}
              onCheckedChange={(checked) =>
                setIsConsentChecked(checked === true)
              }
            />
            <span>{record.disclosure.statement}</span>
          </label>
          {consentError ? (
            <div className="notice notice-danger" role="alert">
              {consentError}
            </div>
          ) : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <ShellButton
              disabled={isSavingConsent}
              onClick={() => {
                setDeclineError(null);
                setIsDeclineDialogOpen(true);
              }}
              variant="secondary"
            >
              Decline
            </ShellButton>
            <ShellButton
              disabled={!isConsentChecked}
              loading={isSavingConsent}
              onClick={handleConsent}
            >
              Agree and continue
            </ShellButton>
          </div>
        </DialogFrame>
      ) : null}

      {isDeclineDialogOpen ? (
        <DialogFrame
          description={`The sender (${record.senderName}) will be notified that you declined. This cannot be undone.`}
          title="Decline to sign?"
          onClose={() => {
            if (isDeclining) {
              return;
            }

            setDeclineError(null);
            setIsDeclineDialogOpen(false);
          }}
        >
          <label className="grid gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-(--secondary)">
              Reason (optional)
            </span>
            <Textarea
              autoFocus
              className="min-h-28"
              id="signing-decline-reason"
              name="signing-decline-reason"
              onChange={(event) => setDeclineReason(event.target.value)}
              placeholder="I'd like to discuss some terms first..."
              value={declineReason}
            />
          </label>
          {declineError ? (
            <div className="notice notice-danger" role="alert">
              {declineError}
            </div>
          ) : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <ShellButton
              disabled={isDeclining}
              onClick={() => {
                setDeclineError(null);
                setIsDeclineDialogOpen(false);
              }}
              variant="secondary"
            >
              Cancel
            </ShellButton>
            <ShellButton
              loading={isDeclining}
              onClick={handleDeclineSigning}
              variant="danger"
            >
              {isDeclining ? "Declining..." : "Decline to sign"}
            </ShellButton>
          </div>
        </DialogFrame>
      ) : null}
    </div>
  );
}

function SigningToolbarStatus({
  hasLockedFields,
  remainingFields,
}: {
  hasLockedFields: boolean;
  remainingFields: number;
}) {
  return (
    <div className="inline-flex min-h-10 items-center gap-2.5 rounded-full bg-(--surface) py-1.5 pl-2.5 pr-4">
      <span
        aria-hidden="true"
        className={`inline-flex size-6 items-center justify-center rounded-full ${
          remainingFields === 0
            ? "bg-(--success-soft) text-(--success)"
            : "bg-(--accent) text-white"
        }`}
      >
        {remainingFields === 0 ? (
          <svg
            aria-hidden="true"
            className="size-3.5"
            fill="none"
            viewBox="0 0 16 16"
          >
            <path
              d="M3.5 8.5 6.5 11.5 12.5 4.5"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        ) : (
          <span className="text-[11px] font-bold leading-none">
            {remainingFields}
          </span>
        )}
      </span>
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-bold leading-tight text-(--fg)">
          {remainingFields === 0
            ? "Ready to finish"
            : `${remainingFields} required remaining`}
        </p>
        <p className="text-xs leading-tight text-(--tertiary)">
          {hasLockedFields ? "Locked values visible" : "Current signer view"}
        </p>
      </div>
    </div>
  );
}

function CurrentSignerField({
  checkboxValue,
  field,
  localDateLabel,
  onCheckboxChange,
  onSignatureClick,
  onTextChange,
  signatureEntry,
  textValue,
}: {
  checkboxValue: boolean;
  field: SigningCurrentField;
  localDateLabel: string;
  onCheckboxChange: (checked: boolean) => void;
  onSignatureClick: () => void;
  onTextChange: (value: string) => void;
  signatureEntry?: SignatureEntry;
  textValue: string;
}) {
  const frame = getFieldFrame(field);
  const showInlineLabel = shouldShowInlineFieldLabel(field);
  const showInlineValue = shouldShowInlineFieldValue(field);

  if (field.type === "signature" || field.type === "initials") {
    return (
      <button
        aria-label={getSummaryLabel(field)}
        className={`absolute z-2 overflow-hidden rounded-[0.375rem] border-2 border-(--accent) text-(--accent-ink) transition ${
          signatureEntry?.value
            ? "bg-[rgba(83,64,214,0.10)]"
            : "bg-[rgba(83,64,214,0.07)] hover:bg-[rgba(83,64,214,0.16)]"
        }`}
        data-signing-field="true"
        onClick={onSignatureClick}
        style={frame}
        type="button"
      >
        <span className="pointer-events-none flex h-full w-full items-center justify-center overflow-hidden px-1 text-center">
          {signatureEntry?.inputMethod === "drawn" &&
          signatureEntry.imageDataUrl ? (
            <span className="relative block h-full w-full">
              <Image
                alt={`${field.type === "initials" ? "Initials" : "Signature"} preview`}
                className="object-contain p-1"
                fill
                src={signatureEntry.imageDataUrl}
                unoptimized
              />
            </span>
          ) : signatureEntry?.value && showInlineValue ? (
            <span
              className="block max-w-full truncate px-1 text-sm"
              style={{
                fontFamily:
                  signatureEntry.inputMethod === "typed"
                    ? typedSignatureFont
                    : undefined,
                fontSize:
                  signatureEntry.inputMethod === "typed"
                    ? "1.05rem"
                    : undefined,
              }}
            >
              {signatureEntry.value}
            </span>
          ) : showInlineLabel ? (
            <span className="block max-w-full truncate px-1 text-xs font-bold">
              {getCanvasFieldLabel(field)}
            </span>
          ) : null}
        </span>
      </button>
    );
  }

  if (field.type === "date") {
    return (
      <div
        className="absolute z-2 overflow-hidden rounded-[0.375rem] border border-(--border-strong) bg-white/92 text-sm text-(--fg)"
        data-signing-field="true"
        style={frame}
      >
        {showInlineValue ? (
          <p className="flex h-full items-center truncate px-2 text-[12px] font-semibold">
            {localDateLabel}
          </p>
        ) : null}
      </div>
    );
  }

  if (field.type === "text") {
    return (
      <div
        className="absolute z-2 overflow-hidden rounded-[0.375rem] border-2 border-(--accent) bg-[rgba(83,64,214,0.07)] focus-within:bg-white"
        data-signing-field="true"
        style={frame}
      >
        <input
          aria-label={getFieldLabel(field)}
          className="h-full w-full border-none bg-transparent px-2 text-sm text-(--fg) outline-none placeholder:text-(--placeholder)"
          id={`signing-field-${field.id}`}
          name={`signing-field-${field.id}`}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={showInlineLabel ? getFieldLabel(field) : ""}
          value={textValue}
        />
      </div>
    );
  }

  return (
    <button
      aria-label={getFieldLabel(field)}
      aria-pressed={checkboxValue}
      className={`absolute z-2 flex items-center justify-center rounded-[0.25rem] border-2 border-(--accent) text-(--accent-ink) transition ${
        checkboxValue
          ? "bg-[rgba(83,64,214,0.14)]"
          : "bg-white hover:bg-[rgba(83,64,214,0.10)]"
      }`}
      data-signing-field="true"
      onClick={() => onCheckboxChange(!checkboxValue)}
      style={frame}
      type="button"
    >
      {checkboxValue ? (
        <svg
          aria-hidden="true"
          className="h-[68%] w-[68%] max-h-4 max-w-4 text-current"
          fill="none"
          viewBox="0 0 16 16"
        >
          <path
            d="M3.5 8.5 6.5 11.5 12.5 4.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
      ) : null}
    </button>
  );
}

function VisibleFieldStamp({ field }: { field: SigningVisibleField }) {
  const frame = getFieldFrame(field);
  const showInlineLabel = shouldShowInlineFieldLabel(field);
  const showInlineValue = shouldShowInlineFieldValue(field);

  if (field.type === "checkbox") {
    return (
      <div
        className="pointer-events-none absolute z-1 flex items-center justify-center rounded-[0.25rem] border border-(--border-strong) bg-[rgba(28,29,43,0.03)]"
        data-signing-field="true"
        style={frame}
      >
        {field.checked ? (
          <svg
            aria-hidden="true"
            className="h-[68%] w-[68%] max-h-4 max-w-4 text-(--secondary)"
            fill="none"
            viewBox="0 0 16 16"
          >
            <path
              d="M3.5 8.5 6.5 11.5 12.5 4.5"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        ) : null}
      </div>
    );
  }

  if (
    (field.type === "signature" || field.type === "initials") &&
    field.imageDataUrl
  ) {
    return (
      <div
        className="pointer-events-none absolute z-1 overflow-hidden rounded-[0.375rem] border border-(--border-strong) bg-[rgba(28,29,43,0.03)]"
        data-signing-field="true"
        style={frame}
      >
        <Image
          alt={`${field.signerName} completed ${field.type}`}
          className="object-contain"
          fill
          src={field.imageDataUrl}
          unoptimized
        />
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none absolute z-1 overflow-hidden rounded-[0.375rem] border border-(--border-strong) bg-[rgba(28,29,43,0.03)] text-(--secondary)"
      data-signing-field="true"
      style={frame}
    >
      <div className="flex h-full w-full items-center overflow-hidden px-1">
        {showInlineValue ? (
          <p
            className={`truncate ${
              showInlineLabel ? "text-[12px]" : "w-full text-center text-[11px]"
            } font-medium`}
            style={{
              fontFamily:
                field.inputMethod === "typed" &&
                (field.type === "signature" || field.type === "initials")
                  ? typedSignatureFont
                  : undefined,
              fontSize:
                field.inputMethod === "typed" &&
                (field.type === "signature" || field.type === "initials")
                  ? "1rem"
                  : undefined,
            }}
          >
            {getVisibleFieldValue(field)}
          </p>
        ) : showInlineLabel ? (
          <p className="w-full truncate text-center text-[11px] font-semibold text-(--tertiary)">
            {getCanvasFieldLabel(field)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SignatureModal({
  existingEntry,
  drawnSignatureVersion,
  fieldType,
  onApply,
  onClearDrawnSignature,
  onClose,
  onModeChange,
  signatureMode,
  signerName,
}: {
  existingEntry?: SignatureEntry;
  drawnSignatureVersion: number;
  fieldType: "initials" | "signature";
  onApply: (entry: SignatureEntry) => void;
  onClearDrawnSignature: () => void;
  onClose: () => void;
  onModeChange: (mode: "drawn" | "typed") => void;
  signatureMode: "drawn" | "typed";
  signerName: string;
}) {
  const [drawnSignatureDataUrl, setDrawnSignatureDataUrl] = useState<
    string | null
  >(
    existingEntry?.inputMethod === "drawn"
      ? (existingEntry.imageDataUrl ?? null)
      : null,
  );
  const [typedSignatureValue, setTypedSignatureValue] = useState(() => {
    if (existingEntry?.inputMethod === "typed" && existingEntry.value.trim()) {
      return existingEntry.value;
    }

    return fieldType === "initials" ? getInitials(signerName) : signerName;
  });
  const drawPreviewMessage =
    drawnSignatureVersion === 0
      ? "Draw with mouse or finger"
      : `Canvas cleared ${drawnSignatureVersion} time${drawnSignatureVersion === 1 ? "" : "s"}`;
  const typedPlaceholder =
    fieldType === "initials" ? "Type your initials" : "Type your signature";
  const normalizedTypedSignatureValue = typedSignatureValue.trim();
  const canApply =
    signatureMode === "typed"
      ? normalizedTypedSignatureValue.length > 0
      : Boolean(drawnSignatureDataUrl);

  function handleTypedSignatureValueChange(value: string) {
    if (fieldType === "initials") {
      setTypedSignatureValue(value.toUpperCase().slice(0, 4));
      return;
    }

    setTypedSignatureValue(value);
  }

  return (
    <DialogFrame
      description="By signing, you agree that this electronic signature is the legal equivalent of your manual signature."
      title={
        fieldType === "initials" ? "Add your initials" : "Add your signature"
      }
      onClose={onClose}
    >
      <Tabs
        className="gap-4"
        onValueChange={(value) => onModeChange(value as "typed" | "drawn")}
        value={signatureMode}
      >
        <TabsList className="segmented flex h-auto w-full p-1 group-data-horizontal/tabs:h-auto">
          <TabsTrigger
            className="segmented-item h-auto min-h-10 flex-1 data-active:bg-white data-active:text-(--fg) data-active:shadow-[0_1px_3px_rgba(28,29,43,0.12)] after:hidden"
            value="typed"
          >
            Type
          </TabsTrigger>
          <TabsTrigger
            className="segmented-item h-auto min-h-10 flex-1 data-active:bg-white data-active:text-(--fg) data-active:shadow-[0_1px_3px_rgba(28,29,43,0.12)] after:hidden"
            value="drawn"
          >
            Draw
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {signatureMode === "typed" ? (
        <div className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-(--secondary)">
              {fieldType === "initials" ? "Type initials" : "Type signature"}
            </span>
            <input
              autoFocus
              className="field-input"
              id={`signature-modal-${fieldType}`}
              maxLength={fieldType === "initials" ? 4 : 80}
              name={`signature-modal-${fieldType}`}
              onChange={(event) =>
                handleTypedSignatureValueChange(event.target.value)
              }
              placeholder={typedPlaceholder}
              value={typedSignatureValue}
            />
          </label>

          <div className="well px-6 py-8 text-center">
            <p
              className={`text-[40px] leading-none sm:text-[52px] ${
                normalizedTypedSignatureValue
                  ? "text-(--fg)"
                  : "text-(--placeholder)"
              }`}
              style={{ fontFamily: typedSignatureFont }}
            >
              {normalizedTypedSignatureValue || typedPlaceholder}
            </p>
            <p className="mt-4 text-xs font-medium text-(--tertiary)">
              Rendered in signature style
            </p>
          </div>
        </div>
      ) : (
        <div className="well p-3">
          <SignatureDrawCanvas
            emptyMessage={drawPreviewMessage}
            initialDataUrl={
              drawnSignatureVersion === 0 &&
              existingEntry?.inputMethod === "drawn"
                ? (existingEntry.imageDataUrl ?? null)
                : null
            }
            key={drawnSignatureVersion}
            onChange={setDrawnSignatureDataUrl}
          />
          <div className="mt-2 flex justify-end">
            <ShellButton
              className="min-h-10 px-4 text-sm"
              onClick={() => {
                setDrawnSignatureDataUrl(null);
                onClearDrawnSignature();
              }}
              variant="ghost"
            >
              Clear
            </ShellButton>
          </div>
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <ShellButton onClick={onClose} variant="secondary">
          Cancel
        </ShellButton>
        <ShellButton
          disabled={!canApply}
          onClick={() =>
            onApply(
              signatureMode === "drawn"
                ? {
                    imageDataUrl: drawnSignatureDataUrl,
                    inputMethod: "drawn",
                    value:
                      fieldType === "initials"
                        ? "Drawn initials"
                        : "Drawn signature",
                  }
                : {
                    imageDataUrl: null,
                    inputMethod: "typed",
                    value: normalizedTypedSignatureValue,
                  },
            )
          }
        >
          {fieldType === "initials" ? "Apply initials" : "Apply signature"}
        </ShellButton>
      </div>
    </DialogFrame>
  );
}

function SignatureDrawCanvas({
  emptyMessage,
  initialDataUrl,
  onChange,
}: {
  emptyMessage: string;
  initialDataUrl?: string | null;
  onChange: (value: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const storedDataUrlRef = useRef<string | null>(initialDataUrl ?? null);
  const [hasSignature, setHasSignature] = useState(Boolean(initialDataUrl));

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const redrawStoredImage = () => {
      const context = canvas.getContext("2d");

      if (!context) {
        return;
      }

      context.clearRect(0, 0, canvas.width, canvas.height);

      if (!storedDataUrlRef.current) {
        return;
      }

      const image = new window.Image();

      image.onload = () => {
        context.drawImage(image, 0, 0, canvas.clientWidth, canvas.clientHeight);
      };
      image.src = storedDataUrlRef.current;
    };

    const resizeCanvas = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const width = Math.max(canvas.offsetWidth, 1);
      const height = Math.max(canvas.offsetHeight, 1);

      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      const context = canvas.getContext("2d");

      if (!context) {
        return;
      }

      context.scale(ratio, ratio);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = 2.2;
      context.strokeStyle = "#111111";
      redrawStoredImage();
    };

    resizeCanvas();
    setHasSignature(Boolean(storedDataUrlRef.current));
    window.addEventListener("resize", resizeCanvas);

    return () => {
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [onChange]);

  function getCanvasPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;

    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    return { x, y };
  }

  function commitDrawing() {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const dataUrl = canvas.toDataURL("image/png");

    storedDataUrlRef.current = dataUrl;
    setHasSignature(true);
    onChange(dataUrl);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const point = getCanvasPoint(event);

    if (!canvas || !context || !point) {
      return;
    }

    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    isDrawingRef.current = true;
    lastPointRef.current = point;
    context.beginPath();
    context.arc(point.x, point.y, 1.2, 0, Math.PI * 2);
    context.fillStyle = "#111111";
    context.fill();
    context.beginPath();
    context.moveTo(point.x, point.y);
    setHasSignature(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const point = getCanvasPoint(event);

    if (
      !isDrawingRef.current ||
      !canvas ||
      !context ||
      !point ||
      !lastPointRef.current
    ) {
      return;
    }

    event.preventDefault();
    context.beginPath();
    context.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPointRef.current = point;
    setHasSignature(true);
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;

    if (!isDrawingRef.current || !canvas) {
      return;
    }

    event.preventDefault();
    isDrawingRef.current = false;
    lastPointRef.current = null;
    canvas.releasePointerCapture(event.pointerId);
    commitDrawing();
  }

  return (
    <div className="relative overflow-hidden rounded-xl border-2 border-dashed border-(--border-strong) bg-white">
      <canvas
        aria-label="Draw signature canvas"
        className="h-[220px] w-full touch-none"
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerEnd}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        ref={canvasRef}
      />
      {!hasSignature ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-(--tertiary)">
          {emptyMessage}
        </div>
      ) : null}
    </div>
  );
}

function DialogFrame({
  children,
  description,
  onClose,
  title,
}: {
  children: ReactNode;
  description: string;
  onClose: () => void;
  title: string;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[600px] p-0" showCloseButton={false}>
        <div>
          <DialogHeader className="space-y-2 px-6 pt-6 sm:px-8 sm:pt-8">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 px-6 pb-6 pt-5 sm:px-8 sm:pb-8">
            {children}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FieldStatusRow({
  isComplete,
  label,
  value,
}: {
  isComplete: boolean;
  label: string;
  value: string;
}) {
  return (
    <div className="well flex items-center justify-between gap-3 rounded-xl px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-(--tertiary)">{label}</p>
        <p className="mt-0.5 truncate text-sm font-semibold text-(--fg)">
          {value}
        </p>
      </div>
      <span
        className={`pill shrink-0 ${isComplete ? "pill-success" : "pill-accent"}`}
      >
        {isComplete ? "Complete" : "Required"}
      </span>
    </div>
  );
}
