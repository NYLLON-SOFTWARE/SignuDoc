"use client";

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type MutableRefObject,
  type MouseEvent,
  type SetStateAction,
} from "react";

import { type PrepareEnvelopeData } from "@/lib/envelopes";
import {
  type FieldPlacement,
  type ReplaceFieldsResponse,
} from "@/lib/schemas/field";
import { CanvasShell } from "@/components/layout/canvas-shell";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@/components/layout/nav-items";
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
import { getCachedDraftPdfBlob } from "@/lib/draft-pdf-cache";
import {
  moveFieldRect,
  placeFieldAtViewportPoint,
  resizeFieldRectFromHandle,
  type FieldResizeHandle,
} from "@/lib/utils/pdf-coords";
import { InteractivePlacedField } from "./interactive-placed-field";
import { PdfPageCanvas } from "./pdf-page-canvas";
import { getSignerPalette } from "./signer-palette";

type PrepareFieldType = FieldPlacement["type"];

type PrepareLiveShellProps = {
  envelopeId: string;
  initialState?: "error";
  record?: PrepareEnvelopeData;
};

type PrepareField = FieldPlacement & {
  id: string;
};

type LiveFieldSource = Array<{
  height: number;
  id: string;
  label?: string;
  page: number;
  required: boolean;
  signerId: string;
  type: PrepareFieldType;
  width: number;
  x: number;
  y: number;
}>;

type PrepareShellSigner = {
  color: string;
  email: string;
  id: string;
  name: string;
  order: number;
  tint: string;
};

type FieldTool = {
  defaultHeight: number;
  defaultWidth: number;
  label: string;
  minHeight: number;
  minWidth: number;
  placeholderLabel: string;
  type: PrepareFieldType;
};

type SignerCardProps = {
  fieldCount: number;
  hasSignatureField: boolean;
  isActive: boolean;
  onSelect: () => void;
  signer: PrepareShellSigner;
};

type FieldToolButtonProps = {
  isActive: boolean;
  onSelect: () => void;
  tool: FieldTool;
};

type FieldEditorProps = {
  field: PrepareField;
  onDelete: () => void;
  onSetRequired: (required: boolean) => void;
  onSignerChange: (signerId: string) => void;
  signers: readonly PrepareShellSigner[];
};

type SaveState = "error" | "saved" | "saving";
type PersistFieldsResult = {
  ok: boolean;
  redirectPath: string | null;
};
const fieldTools: readonly FieldTool[] = [
  {
    defaultHeight: 0.07,
    defaultWidth: 0.24,
    label: "Signature",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Sign",
    type: "signature",
  },
  {
    defaultHeight: 0.055,
    defaultWidth: 0.14,
    label: "Initials",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Initials",
    type: "initials",
  },
  {
    defaultHeight: 0.045,
    defaultWidth: 0.12,
    label: "Date",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Date",
    type: "date",
  },
  {
    defaultHeight: 0.055,
    defaultWidth: 0.18,
    label: "Text",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Text",
    type: "text",
  },
  {
    defaultHeight: 0.023,
    defaultWidth: 0.03,
    label: "Checkbox",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Checkbox",
    type: "checkbox",
  },
] as const;

const genericSubmitError = "Something went wrong. Please try again.";
const autosaveDelayMs = 450;

function buildLiveSigners(
  signers: PrepareEnvelopeData["signers"],
): PrepareShellSigner[] {
  return signers
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((signer, index) => ({
      ...getSignerPalette(index),
      email: signer.email,
      id: signer.id,
      name: signer.name,
      order: signer.order,
    }));
}

function buildLiveFields(
  fields: LiveFieldSource | PrepareEnvelopeData["fields"],
) {
  return fields.map((field, index) => ({
    height: field.height,
    id: field.id ?? `field-${index + 1}`,
    label: field.label,
    page: field.page,
    required: field.required,
    signerId: field.signerId,
    type: field.type,
    width: field.width,
    x: field.x,
    y: field.y,
  }));
}

function getFieldTool(type: PrepareFieldType) {
  return fieldTools.find((tool) => tool.type === type) ?? fieldTools[0];
}

function roundNormalized(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isTextEntryTarget(target: EventTarget | null) {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }

  return target instanceof HTMLElement && target.isContentEditable;
}

function clearSelectedFieldFromViewportClick(
  event: ReactPointerEvent<HTMLElement>,
  armedTool: PrepareFieldType | null,
  setSelectedFieldId: Dispatch<SetStateAction<string | null>>,
) {
  if (armedTool) {
    return;
  }

  const target = event.target;

  if (
    target instanceof HTMLElement &&
    target.closest("[data-placed-field='true']")
  ) {
    return;
  }

  setSelectedFieldId(null);
}

function buildFieldRequest(fields: readonly PrepareField[]) {
  return {
    fields: fields.map((field) => ({
      height: roundNormalized(field.height),
      id: field.id,
      label: field.label,
      page: field.page,
      required: field.required,
      signerId: field.signerId,
      type: field.type,
      width: roundNormalized(field.width),
      x: roundNormalized(field.x),
      y: roundNormalized(field.y),
    })),
  };
}

function serializeFieldRequest(fields: readonly PrepareField[]) {
  return JSON.stringify(buildFieldRequest(fields));
}

async function parseJsonResponse<T>(
  response: Response,
): Promise<{ data: T | null; error: string | null }> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;

  if (!response.ok) {
    return {
      data: null,
      error:
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : genericSubmitError,
    };
  }

  return {
    data: payload as T | null,
    error: null,
  };
}

export function PrepareLiveShell({
  envelopeId,
  initialState,
  record,
}: PrepareLiveShellProps) {
  if (initialState === "error" || !record) {
    return <PrepareLiveShellError envelopeId={envelopeId} />;
  }

  return <PrepareLiveShellContent envelopeId={envelopeId} record={record} />;
}

function PrepareLiveShellError({ envelopeId }: { envelopeId: string }) {
  return (
    <CanvasShell
      backHref={`/envelopes/${envelopeId}/signers`}
      backLabel="Back"
      nextDisabled
      nextLabel="Next →"
      stepLabel="Step 3 of 4"
      title='"Document"'
    >
      <div className="flex min-h-[calc(100vh-73px)] items-center justify-center p-4 sm:p-6 lg:p-8">
        <section className="app-surface-strong w-full max-w-[520px] p-8 text-center sm:p-10">
          <div className="mx-auto inline-flex size-16 items-center justify-center rounded-full bg-[rgba(180,35,53,0.1)] text-lg font-semibold text-(--accent)">
            !
          </div>
          <h1 className="mt-6 text-[28px] font-semibold tracking-[-0.04em] text-(--fg)">
            Couldn&apos;t load this document
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Something went wrong. Please try again.
          </p>
          <button
            className="mt-8 inline-flex min-h-11 items-center justify-center rounded-full bg-(--accent) px-5 text-sm font-semibold text-white shadow-[0_14px_28px_rgba(180,35,53,0.22)] transition hover:bg-(--accent-hover)"
            onClick={() => window.location.reload()}
            type="button"
          >
            Retry
          </button>
        </section>
      </div>
    </CanvasShell>
  );
}

function PrepareLiveShellContent({
  envelopeId,
  record,
}: {
  envelopeId: string;
  record: PrepareEnvelopeData;
}) {
  const signers = buildLiveSigners(record.signers);
  const initialFields = buildLiveFields(record.fields);
  const [activePage, setActivePage] = useState(1);
  const [selectedSignerId, setSelectedSignerId] = useState(
    signers[0]?.id ?? "",
  );
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [armedTool, setArmedTool] = useState<PrepareFieldType | null>(null);
  const [fields, setFields] = useState<PrepareField[]>(initialFields);
  const [isMobileToolsOpen, setIsMobileToolsOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isContinuing, setIsContinuing] = useState(false);
  const [isFieldInteracting, setIsFieldInteracting] = useState(false);
  const [isDocumentPanning, setIsDocumentPanning] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_DOCUMENT_ZOOM_LEVEL);
  const [preferredDocumentUrl, setPreferredDocumentUrl] = useState<
    string | null
  >(null);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const paperGridRef = useRef<HTMLDivElement | null>(null);
  const documentPanGestureRef = useRef<DocumentPanGesture | null>(null);
  const currentFieldsRef = useRef(fields);
  const lastSavedSignatureRef = useRef(serializeFieldRequest(initialFields));
  const fieldCounterRef = useRef(initialFields.length);
  const persistFieldsRef = useRef<
    (nextFields: readonly PrepareField[]) => Promise<PersistFieldsResult>
  >(async () => ({
    ok: false,
    redirectPath: null,
  }));

  currentFieldsRef.current = fields;

  const pageCount = record.pages.length;
  const pageFields = fields.filter((field) => field.page === activePage);
  const activePageRecord =
    record.pages.find((page) => page.pageNumber === activePage) ??
    record.pages[0];
  const selectedField =
    fields.find(
      (field) => field.id === selectedFieldId && field.page === activePage,
    ) ?? null;
  const selectedSigner =
    signers.find((signer) => signer.id === selectedSignerId) ?? signers[0];
  const missingSignatureSigner = signers.find(
    (signer) =>
      !fields.some(
        (field) => field.signerId === signer.id && field.type === "signature",
      ),
  );
  const canContinue = missingSignatureSigner == null;

  useEffect(() => {
    let isActive = true;
    let localDocumentUrl: string | null = null;

    setPreferredDocumentUrl(null);

    async function resolvePreferredDocumentUrl() {
      try {
        const cachedPdfBlob = await getCachedDraftPdfBlob(envelopeId);

        if (!isActive) {
          return;
        }

        if (cachedPdfBlob) {
          localDocumentUrl = URL.createObjectURL(cachedPdfBlob);
          setPreferredDocumentUrl(localDocumentUrl);
          return;
        }
      } catch (error) {
        console.error("Failed to restore the cached draft PDF preview.", error);
      }

      if (isActive) {
        setPreferredDocumentUrl(record.pdfUrl);
      }
    }

    void resolvePreferredDocumentUrl();

    return () => {
      isActive = false;

      if (localDocumentUrl) {
        URL.revokeObjectURL(localDocumentUrl);
      }
    };
  }, [envelopeId, record.pdfUrl]);

  useEffect(() => {
    return () => {
      if (autosaveTimeoutRef.current) {
        window.clearTimeout(autosaveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedFieldId) {
      return;
    }

    const fieldId = selectedFieldId;

    function handleDeleteFieldKeydown(event: KeyboardEvent) {
      if (event.defaultPrevented || isFieldInteracting) {
        return;
      }

      if (event.key !== "Backspace" && event.key !== "Delete") {
        return;
      }

      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (isTextEntryTarget(event.target)) {
        return;
      }

      event.preventDefault();
      deleteField(fieldId, setFields, setSelectedFieldId);
    }

    window.addEventListener("keydown", handleDeleteFieldKeydown);

    return () => {
      window.removeEventListener("keydown", handleDeleteFieldKeydown);
    };
  }, [isFieldInteracting, selectedFieldId]);

  useEffect(() => {
    if (zoomLevel > DEFAULT_DOCUMENT_ZOOM_LEVEL) {
      return;
    }

    setIsDocumentPanning(false);
    documentPanGestureRef.current = null;
  }, [zoomLevel]);

  async function persistFields(nextFields: readonly PrepareField[]) {
    const requestedSignature = serializeFieldRequest(nextFields);

    setSaveError(null);
    setSaveState("saving");

    const response = await fetch(`/api/envelopes/${envelopeId}/fields`, {
      body: JSON.stringify(buildFieldRequest(nextFields)),
      headers: {
        "content-type": "application/json",
      },
      method: "PUT",
    });
    const payload = await parseJsonResponse<ReplaceFieldsResponse>(response);

    if (payload.error) {
      setSaveError(payload.error);
      setSaveState("error");
      return {
        ok: false,
        redirectPath: null,
      };
    }

    if (
      serializeFieldRequest(currentFieldsRef.current) !== requestedSignature
    ) {
      return {
        ok: false,
        redirectPath: payload.data?.redirectPath ?? null,
      };
    }

    const savedFields = payload.data?.fields
      ? buildLiveFields(payload.data.fields)
      : [...nextFields];
    const savedSignature = serializeFieldRequest(savedFields);

    lastSavedSignatureRef.current = savedSignature;
    setFields(savedFields);
    setSaveState("saved");

    return {
      ok: true,
      redirectPath: payload.data?.redirectPath ?? null,
    };
  }

  persistFieldsRef.current = persistFields;

  useEffect(() => {
    const nextSignature = serializeFieldRequest(fields);

    if (nextSignature === lastSavedSignatureRef.current) {
      return;
    }

    if (isFieldInteracting) {
      return;
    }

    if (autosaveTimeoutRef.current) {
      window.clearTimeout(autosaveTimeoutRef.current);
    }

    autosaveTimeoutRef.current = window.setTimeout(() => {
      void persistFieldsRef.current(currentFieldsRef.current);
      autosaveTimeoutRef.current = null;
    }, autosaveDelayMs);

    setSaveState("saving");

    return () => {
      if (autosaveTimeoutRef.current) {
        window.clearTimeout(autosaveTimeoutRef.current);
        autosaveTimeoutRef.current = null;
      }
    };
  }, [fields, isFieldInteracting]);

  async function handleContinue() {
    if (!canContinue || isContinuing) {
      return;
    }

    setIsContinuing(true);

    try {
      const currentSignature = serializeFieldRequest(fields);
      let redirectPath = `/envelopes/${envelopeId}/review`;

      if (currentSignature !== lastSavedSignatureRef.current) {
        const saveResult = await persistFields(fields);

        if (!saveResult.ok) {
          return;
        }

        redirectPath = saveResult.redirectPath ?? redirectPath;
      }

      window.location.assign(redirectPath);
    } finally {
      setIsContinuing(false);
    }
  }

  function beginDocumentPan(event: ReactPointerEvent<HTMLDivElement>) {
    documentPanGestureRef.current = beginDocumentPanGesture({
      canStart: !armedTool,
      event,
      scrollContainer: paperGridRef.current,
      shouldIgnoreTarget: (target) =>
        Boolean(target.closest("[data-placed-field='true']")),
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
    <CanvasShell
      backHref={`/envelopes/${envelopeId}/signers`}
      backLabel="Back"
      nextDisabled={!canContinue}
      nextLabel="Next →"
      nextLoading={isContinuing}
      onNext={handleContinue}
      stepLabel="Step 3 of 4"
      title={`"${record.title}"`}
    >
      <div className="grid min-h-[calc(100vh-73px)] lg:grid-cols-[280px_minmax(0,1fr)_320px]">
        <aside className="hidden border-r border-(--border) bg-[rgba(251,248,242,0.88)] lg:block">
          <div className="flex h-full flex-col gap-8 p-5">
            <section className="space-y-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
                Fields
              </p>
              <div className="grid gap-3">
                {fieldTools.map((tool) => (
                  <FieldToolButton
                    isActive={armedTool === tool.type}
                    key={tool.type}
                    onSelect={() =>
                      handleToolSelect(
                        tool.type,
                        setArmedTool,
                        setSelectedFieldId,
                        setIsMobileToolsOpen,
                      )
                    }
                    tool={tool}
                  />
                ))}
              </div>
            </section>

            <section className="space-y-4 border-t border-(--border) pt-6">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
                  Signers
                </p>
                <span className="text-xs font-medium text-(--tertiary)">
                  {fields.length} fields placed
                </span>
              </div>
              <div className="space-y-3">
                {signers.map((signer) => {
                  const signerFields = fields.filter(
                    (field) => field.signerId === signer.id,
                  );

                  return (
                    <SignerCard
                      fieldCount={signerFields.length}
                      hasSignatureField={signerFields.some(
                        (field) => field.type === "signature",
                      )}
                      isActive={selectedSignerId === signer.id}
                      key={signer.id}
                      onSelect={() => setSelectedSignerId(signer.id)}
                      signer={signer}
                    />
                  );
                })}
              </div>
            </section>
          </div>
        </aside>

        <section className="flex min-w-0 flex-col gap-4 p-4 sm:p-6 lg:p-8">
          <div className="editorial-panel px-4 py-3 sm:px-5">
            <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center">
              <div className="flex justify-center lg:justify-start">
                <DocumentZoomControls
                  onDecrease={() =>
                    setZoomLevel((currentZoom) =>
                      clampDocumentZoomLevel(
                        currentZoom - DOCUMENT_ZOOM_STEP,
                      ),
                    )
                  }
                  onIncrease={() =>
                    setZoomLevel((currentZoom) =>
                      clampDocumentZoomLevel(
                        currentZoom + DOCUMENT_ZOOM_STEP,
                      ),
                    )
                  }
                  onReset={() => setZoomLevel(DEFAULT_DOCUMENT_ZOOM_LEVEL)}
                  zoomLevel={zoomLevel}
                />
              </div>

              <div className="flex items-center justify-center gap-3">
                <button
                  aria-label="Previous page"
                  className="inline-flex size-11 items-center justify-center rounded-none border border-(--border) bg-white text-muted-foreground transition hover:border-black hover:bg-white disabled:cursor-not-allowed disabled:text-(--placeholder)"
                  disabled={activePage === 1}
                  onClick={() =>
                    changePage(
                      activePage - 1,
                      pageCount,
                      setActivePage,
                      setSelectedFieldId,
                      setArmedTool,
                    )
                  }
                  type="button"
                >
                  <ChevronLeftIcon className="size-4" />
                </button>
                <div className="min-w-[132px] text-center">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-(--tertiary)">
                    Document page
                  </p>
                  <p className="mt-1 text-sm font-semibold text-(--fg)">
                    {`Page ${activePage} of ${pageCount}`}
                  </p>
                </div>
                <button
                  aria-label="Next page"
                  className="inline-flex size-11 items-center justify-center rounded-none border border-(--border) bg-white text-muted-foreground transition hover:border-black hover:bg-white disabled:cursor-not-allowed disabled:text-(--placeholder)"
                  disabled={activePage === pageCount}
                  onClick={() =>
                    changePage(
                      activePage + 1,
                      pageCount,
                      setActivePage,
                      setSelectedFieldId,
                      setArmedTool,
                    )
                  }
                  type="button"
                >
                  <ChevronRightIcon className="size-4" />
                </button>
              </div>

              <div className="flex justify-center lg:justify-end">
                <SaveStatusIndicator
                  onRetrySave={() => void persistFields(currentFieldsRef.current)}
                  saveError={saveError}
                  saveState={saveState}
                />
              </div>
            </div>
          </div>

          <div className="editorial-panel p-4 lg:hidden">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <label className="grid gap-2 text-sm">
                <span className="font-semibold text-(--fg)">
                  Selected signer
                </span>
                <select
                  aria-label="Selected signer"
                  className="min-h-12 rounded-none border border-(--border) bg-popover px-4 text-(--fg)"
                  onChange={(event) => setSelectedSignerId(event.target.value)}
                  value={selectedSignerId}
                >
                  {signers.map((signer) => (
                    <option key={signer.id} value={signer.id}>
                      {signer.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-none border border-(--border) bg-(--surface) px-5 [font-family:var(--font-mono)] text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-(--fg) transition hover:border-black hover:bg-white"
                onClick={() => setIsMobileToolsOpen(true)}
                type="button"
              >
                Open field tools
              </button>
            </div>
          </div>

          <div className="editorial-panel p-3 sm:p-4">
            <div
              className={`relative overflow-auto border border-(--border) bg-(--surface) p-3 sm:p-5 ${
                zoomLevel > DEFAULT_DOCUMENT_ZOOM_LEVEL && !armedTool
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
                className={`mx-auto ${zoomLevel > DEFAULT_DOCUMENT_ZOOM_LEVEL ? "w-full" : "flex justify-center"}`}
              >
                <div
                  className="relative border border-[rgba(17,17,17,0.08)] bg-white"
                  style={{
                    width: `${zoomLevel * 100}%`,
                  }}
                >
                  <div
                    className="relative overflow-hidden"
                    data-field-viewport
                    onPointerDown={(event) =>
                      clearSelectedFieldFromViewportClick(
                        event,
                        armedTool,
                        setSelectedFieldId,
                      )
                    }
                    style={{
                      aspectRatio: `${activePageRecord.widthPt} / ${activePageRecord.heightPt}`,
                    }}
                  >
                    <PdfPageCanvas
                      documentUrl={preferredDocumentUrl}
                      pageNumber={activePage}
                    />

                    {armedTool ? (
                      <button
                        aria-label={`Place ${getFieldTool(armedTool).label} on page ${activePage}`}
                        className="absolute inset-0 z-10 cursor-copy rounded-[28px] bg-transparent"
                        onClick={(event) =>
                          placeField(
                            event,
                            activePage,
                            armedTool,
                            fieldCounterRef,
                            selectedSignerId,
                            setArmedTool,
                            setFields,
                            setSelectedFieldId,
                          )
                        }
                        type="button"
                      >
                        <span className="sr-only">
                          Place {getFieldTool(armedTool).label} on the document
                          page
                        </span>
                      </button>
                    ) : null}

                    {fields.length === 0 ? (
                      <div className="absolute inset-0 z-1 flex items-center justify-center px-6">
                        <div className="max-w-[300px] border border-dashed border-[rgba(17,17,17,0.12)] bg-white/92 px-6 py-8 text-center">
                          <p className="text-lg font-semibold tracking-[-0.03em] text-(--fg)">
                            No fields placed yet
                          </p>
                          <p className="mt-3 text-sm leading-6 text-muted-foreground">
                            Pick a field, then click the page to place it for
                            the selected signer.
                          </p>
                        </div>
                      </div>
                    ) : null}

                    {pageFields.map((field) => {
                      const signer =
                        signers.find((entry) => entry.id === field.signerId) ??
                        signers[0];

                      return (
                        <InteractivePlacedField
                          coordinateScale={1}
                          field={field}
                          isSelected={selectedField?.id === field.id}
                          key={field.id}
                          label={getFieldTool(field.type).placeholderLabel}
                          onInteractionChange={setIsFieldInteracting}
                          onMove={(deltaX, deltaY) =>
                            moveField(field.id, deltaX, deltaY, setFields)
                          }
                          onResize={(corner, deltaX, deltaY) =>
                            resizeField(
                              field.id,
                              corner,
                              deltaX,
                              deltaY,
                              setFields,
                            )
                          }
                          onSelect={() => {
                            setArmedTool(null);
                            setSelectedSignerId(field.signerId);
                            setSelectedFieldId(field.id);
                          }}
                          signer={signer}
                        />
                      );
                    })}

                    {armedTool ? (
                      <div className="pointer-events-none absolute inset-x-4 bottom-4 z-11 border border-[rgba(180,35,53,0.12)] bg-white/94 px-4 py-3 sm:inset-x-6 sm:bottom-6">
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-(--accent)">
                          Ready to place
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          Click the page to place{" "}
                          <span className="font-semibold text-(--fg)">
                            {getFieldTool(armedTool).label}
                          </span>{" "}
                          for{" "}
                          <span className="font-semibold text-(--fg)">
                            {selectedSigner.name}
                          </span>
                          .
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {selectedField ? (
            <div className="editorial-panel p-4 lg:hidden">
              <FieldEditor
                field={selectedField}
                onDelete={() =>
                  deleteField(selectedField.id, setFields, setSelectedFieldId)
                }
                onSetRequired={(required) =>
                  setFieldRequired(selectedField.id, required, setFields)
                }
                onSignerChange={(signerId) => {
                  setSelectedSignerId(signerId);
                  reassignField(selectedField.id, signerId, setFields);
                }}
                signers={signers}
              />
            </div>
          ) : null}

          <div className="grid gap-4 lg:hidden">
            <SelectedSignerPanel
              armedTool={armedTool}
              selectedSigner={selectedSigner}
            />
          </div>
        </section>

        <aside className="hidden border-l border-(--border) bg-white/92 lg:block">
          <div className="flex h-full flex-col gap-6 p-5">
            <section className="space-y-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
                Inspector
              </p>
              <div className="border border-(--border) bg-(--surface) p-4">
                {selectedField ? (
                  <FieldEditor
                    field={selectedField}
                    onDelete={() =>
                      deleteField(
                        selectedField.id,
                        setFields,
                        setSelectedFieldId,
                      )
                    }
                    onSetRequired={(required) =>
                      setFieldRequired(selectedField.id, required, setFields)
                    }
                    onSignerChange={(signerId) => {
                      setSelectedSignerId(signerId);
                      reassignField(selectedField.id, signerId, setFields);
                    }}
                    signers={signers}
                  />
                ) : (
                  <EmptyFieldInspector
                    armedTool={armedTool}
                    selectedSigner={selectedSigner}
                  />
                )}
              </div>
            </section>

            <SelectedSignerPanel
              armedTool={armedTool}
              selectedSigner={selectedSigner}
            />
          </div>
        </aside>
      </div>

      {isMobileToolsOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label="Close field tools"
            className="absolute inset-0 bg-[rgba(17,17,17,0.36)]"
            onClick={() => setIsMobileToolsOpen(false)}
            type="button"
          />
          <div
            aria-label="Field tools"
            className="absolute inset-x-0 bottom-0 rounded-t-[32px] border border-(--border) bg-[rgba(255,255,255,0.94)] px-4 py-5 shadow-[0_-24px_60px_rgba(17,17,17,0.18)]"
            role="dialog"
          >
            <div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-(--border)" />
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
                  Fields
                </p>
                <button
                  className="text-sm font-semibold text-muted-foreground"
                  onClick={() => setIsMobileToolsOpen(false)}
                  type="button"
                >
                  Done
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {fieldTools.map((tool) => (
                  <FieldToolButton
                    isActive={armedTool === tool.type}
                    key={`mobile-${tool.type}`}
                    onSelect={() =>
                      handleToolSelect(
                        tool.type,
                        setArmedTool,
                        setSelectedFieldId,
                        setIsMobileToolsOpen,
                      )
                    }
                    tool={tool}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </CanvasShell>
  );
}

function FieldToolButton({ isActive, onSelect, tool }: FieldToolButtonProps) {
  return (
    <button
      aria-label={tool.label}
      aria-pressed={isActive}
      className={`flex min-h-12 items-center justify-between rounded-none border px-4 text-left text-sm font-semibold transition ${
        isActive
          ? "border-[rgba(180,35,53,0.28)] bg-[rgba(180,35,53,0.08)] text-(--fg)"
          : "border-(--border) bg-(--surface) text-(--fg) hover:border-[rgba(17,17,17,0.16)] hover:bg-white"
      }`}
      onClick={onSelect}
      type="button"
    >
      <span>{tool.label}</span>
      <span className="text-xs uppercase tracking-[0.16em] text-(--tertiary)">
        Place
      </span>
    </button>
  );
}

function SignerCard({
  fieldCount,
  hasSignatureField,
  isActive,
  onSelect,
  signer,
}: SignerCardProps) {
  return (
    <button
      aria-pressed={isActive}
      className={`w-full border px-4 py-4 text-left transition ${
        isActive
          ? "border-black bg-white"
          : "border-(--border) bg-white hover:border-[rgba(17,17,17,0.16)]"
      }`}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex size-10 items-center justify-center rounded-full text-sm font-semibold"
          style={{
            backgroundColor: signer.tint,
            color: signer.color,
          }}
        >
          {signer.name
            .split(" ")
            .map((part) => part[0])
            .join("")}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-(--fg)">{signer.name}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {fieldCount} field{fieldCount === 1 ? "" : "s"} placed
          </p>
          <p
            className="mt-2 text-xs font-semibold uppercase tracking-[0.18em]"
            style={{
              color: hasSignatureField ? signer.color : "var(--accent)",
            }}
          >
            {hasSignatureField ? "Signature ready" : "Signature needed"}
          </p>
        </div>
      </div>
    </button>
  );
}

function EmptyFieldInspector({
  armedTool,
  selectedSigner,
}: {
  armedTool: PrepareFieldType | null;
  selectedSigner: PrepareShellSigner;
}) {
  const activeTool = armedTool ? getFieldTool(armedTool) : null;

  return (
    <div className="border border-dashed border-(--border) bg-[rgba(247,247,248,0.92)] px-4 py-5">
      <p className="text-sm font-semibold text-(--fg)">
        {activeTool ? `${activeTool.label} ready to place` : "No field selected"}
      </p>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {activeTool
          ? `Click the document to place ${activeTool.label.toLowerCase()} for ${selectedSigner.name}.`
          : "Select a field on the page to edit its settings, or choose a field tool on the left to place a new one."}
      </p>
    </div>
  );
}

function SelectedSignerPanel({
  armedTool,
  selectedSigner,
}: {
  armedTool: PrepareFieldType | null;
  selectedSigner: PrepareShellSigner;
}) {
  const activeTool = armedTool ? getFieldTool(armedTool) : null;

  return (
    <section className="space-y-4 border border-(--border) bg-(--surface) p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
        Selected signer
      </p>
      <div className="flex items-center gap-3">
        <span
          className="inline-flex size-10 items-center justify-center rounded-full text-sm font-semibold"
          style={{
            backgroundColor: selectedSigner.tint,
            color: selectedSigner.color,
          }}
        >
          {selectedSigner.name
            .split(" ")
            .map((part) => part[0])
            .join("")}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-(--fg)">
            {selectedSigner.name}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {activeTool
              ? `Placing ${activeTool.label.toLowerCase()}`
              : "New fields will be assigned here"}
          </p>
        </div>
      </div>
    </section>
  );
}

function SaveStatusIndicator({
  onRetrySave,
  saveError,
  saveState,
}: {
  onRetrySave: () => void;
  saveError: string | null;
  saveState: SaveState;
}) {
  const isError = saveState === "error" && saveError;
  const isSaving = saveState === "saving";

  return (
    <div
      aria-live="polite"
      className={`inline-flex min-h-11 items-center gap-3 border px-3 py-2 text-sm ${
        isError
          ? "border-[rgba(180,35,53,0.18)] bg-[rgba(180,35,53,0.06)]"
          : "border-(--border) bg-white"
      }`}
      role={isError ? "alert" : "status"}
    >
      <span
        aria-hidden="true"
        className={`inline-flex size-5 items-center justify-center rounded-full ${
          isError
            ? "bg-[rgba(180,35,53,0.12)] text-(--accent)"
            : isSaving
              ? "bg-[rgba(17,17,17,0.04)] text-(--fg)"
              : "bg-[rgba(24,132,74,0.12)] text-[rgb(24,132,74)]"
        }`}
      >
        {isError ? (
          <span className="text-[13px] font-semibold leading-none">!</span>
        ) : isSaving ? (
          <span className="size-3.5 animate-spin rounded-full border-2 border-[rgba(17,17,17,0.18)] border-t-(--fg)" />
        ) : (
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
        )}
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-(--fg)">
          {isError ? "Save failed" : isSaving ? "Saving..." : "Saved"}
        </p>
        {saveError ? (
          <p className="truncate text-xs text-(--accent)">{saveError}</p>
        ) : null}
      </div>
      {isError ? (
        <button
          className="inline-flex min-h-9 items-center justify-center border border-[rgba(180,35,53,0.14)] bg-white px-3 [font-family:var(--font-mono)] text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-(--accent)"
          onClick={onRetrySave}
          type="button"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function FieldEditor({
  field,
  onDelete,
  onSetRequired,
  onSignerChange,
  signers,
}: FieldEditorProps) {
  const tool = getFieldTool(field.type);
  const isOptionalField = field.type === "text" || field.type === "checkbox";

  return (
    <section aria-label="Field settings" role="region">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-(--tertiary)">
          Field settings
        </p>
        <p className="mt-2 text-sm font-semibold text-(--fg)">{tool.label}</p>
      </div>

      <div className="mt-4 space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-(--tertiary)">
            Assigned to
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {signers.map((signer) => (
              <button
                className={`min-h-11 rounded-none border px-3 text-sm font-semibold transition ${
                  field.signerId === signer.id
                    ? "border-transparent bg-(--fg) text-white"
                    : "border-(--border) bg-(--surface) text-(--fg) hover:bg-white"
                }`}
                key={signer.id}
                onClick={() => onSignerChange(signer.id)}
                type="button"
              >
                {signer.name}
              </button>
            ))}
          </div>
        </div>

        {isOptionalField ? (
          <div>
            <div className="border border-(--border) bg-(--surface) px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-(--tertiary)">
                Required
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {[
                  {
                    label: "Required",
                    value: true,
                  },
                  {
                    label: "Optional",
                    value: false,
                  },
                ].map((option) => (
                  <button
                    className={`min-h-11 rounded-none border px-3 text-sm font-semibold transition ${
                      field.required === option.value
                        ? "border-transparent bg-(--fg) text-white"
                        : "border-(--border) bg-(--surface) text-(--fg) hover:bg-white"
                    }`}
                    key={option.label}
                    onClick={() => onSetRequired(option.value)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <button
          className="inline-flex min-h-11 w-full items-center justify-center rounded-none border border-[rgba(180,35,53,0.16)] bg-[rgba(180,35,53,0.08)] px-5 [font-family:var(--font-mono)] text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-(--accent) transition hover:bg-[rgba(180,35,53,0.14)]"
          onClick={onDelete}
          type="button"
        >
          Delete
        </button>
      </div>
    </section>
  );
}

function handleToolSelect(
  tool: PrepareFieldType,
  setArmedTool: Dispatch<SetStateAction<PrepareFieldType | null>>,
  setSelectedFieldId: Dispatch<SetStateAction<string | null>>,
  setIsMobileToolsOpen: Dispatch<SetStateAction<boolean>>,
) {
  setSelectedFieldId(null);
  setArmedTool((currentTool) => (currentTool === tool ? null : tool));
  setIsMobileToolsOpen(false);
}

function placeField(
  event: MouseEvent<HTMLButtonElement>,
  activePage: number,
  armedTool: PrepareFieldType,
  fieldCounterRef: MutableRefObject<number>,
  selectedSignerId: string,
  setArmedTool: Dispatch<SetStateAction<PrepareFieldType | null>>,
  setFields: Dispatch<SetStateAction<PrepareField[]>>,
  setSelectedFieldId: Dispatch<SetStateAction<string | null>>,
) {
  const pageRect = event.currentTarget.getBoundingClientRect();
  const tool = getFieldTool(armedTool);
  const nextRect = placeFieldAtViewportPoint({
    clientX: event.clientX - pageRect.left,
    clientY: event.clientY - pageRect.top,
    fieldHeight: tool.defaultHeight,
    fieldWidth: tool.defaultWidth,
    viewportHeight: pageRect.height,
    viewportWidth: pageRect.width,
  });

  fieldCounterRef.current += 1;
  const nextField: PrepareField = {
    ...nextRect,
    id:
      typeof window !== "undefined" && "crypto" in window
        ? window.crypto.randomUUID()
        : `field-${fieldCounterRef.current}`,
    label: undefined,
    page: activePage,
    required: tool.type === "text" || tool.type === "checkbox" ? false : true,
    signerId: selectedSignerId,
    type: tool.type,
  };

  setFields((currentFields) => [...currentFields, nextField]);
  setSelectedFieldId(nextField.id);
  setArmedTool(null);
}

function reassignField(
  fieldId: string,
  signerId: string,
  setFields: Dispatch<SetStateAction<PrepareField[]>>,
) {
  setFields((currentFields) =>
    currentFields.map((field) =>
      field.id === fieldId ? { ...field, signerId } : field,
    ),
  );
}

function moveField(
  fieldId: string,
  deltaX: number,
  deltaY: number,
  setFields: Dispatch<SetStateAction<PrepareField[]>>,
) {
  if (deltaX === 0 && deltaY === 0) {
    return;
  }

  setFields((currentFields) =>
    currentFields.map((field) =>
      field.id === fieldId
        ? {
            ...field,
            ...moveFieldRect({
              deltaX,
              deltaY,
              rect: field,
            }),
          }
        : field,
    ),
  );
}

function resizeField(
  fieldId: string,
  corner: FieldResizeHandle,
  deltaX: number,
  deltaY: number,
  setFields: Dispatch<SetStateAction<PrepareField[]>>,
) {
  if (deltaX === 0 && deltaY === 0) {
    return;
  }

  setFields((currentFields) =>
    currentFields.map((field) => {
      if (field.id !== fieldId) {
        return field;
      }

      const tool = getFieldTool(field.type);
      const resizedRect = resizeFieldRectFromHandle({
        corner,
        deltaX,
        deltaY,
        minHeight: tool.minHeight,
        minWidth: tool.minWidth,
        rect: field,
      });

      return {
        ...field,
        ...resizedRect,
      };
    }),
  );
}

function setFieldRequired(
  fieldId: string,
  required: boolean,
  setFields: Dispatch<SetStateAction<PrepareField[]>>,
) {
  setFields((currentFields) =>
    currentFields.map((field) => {
      if (field.id !== fieldId) {
        return field;
      }

      if (field.type !== "text" && field.type !== "checkbox") {
        return field;
      }

      return {
        ...field,
        required,
      };
    }),
  );
}

function deleteField(
  fieldId: string,
  setFields: Dispatch<SetStateAction<PrepareField[]>>,
  setSelectedFieldId: Dispatch<SetStateAction<string | null>>,
) {
  setFields((currentFields) =>
    currentFields.filter((field) => field.id !== fieldId),
  );
  setSelectedFieldId(null);
}

function changePage(
  nextPage: number,
  pageCount: number,
  setActivePage: Dispatch<SetStateAction<number>>,
  setSelectedFieldId: Dispatch<SetStateAction<string | null>>,
  setArmedTool: Dispatch<SetStateAction<PrepareFieldType | null>>,
) {
  setActivePage(clamp(nextPage, 1, pageCount));
  setSelectedFieldId(null);
  setArmedTool(null);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
