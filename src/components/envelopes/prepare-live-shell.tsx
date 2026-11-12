"use client";

import {
  CalendarIcon,
  CaseSensitiveIcon,
  SignatureIcon,
  SquareCheckIcon,
  TypeIcon,
  type LucideIcon,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
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
        <section className="panel w-full max-w-[520px] p-8 text-center sm:p-10">
          <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-(--danger-soft) text-lg font-extrabold text-(--danger)">
            !
          </div>
          <h1 className="mt-5 text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Couldn&apos;t load this document
          </h1>
          <p className="mt-2 text-sm leading-6 text-(--secondary)">
            Something went wrong. Please try again.
          </p>
          <Button
            className="mt-7"
            onClick={() => window.location.reload()}
            type="button"
          >
            Retry
          </Button>
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
      <div className="grid min-h-[calc(100vh-73px)] lg:grid-cols-[272px_minmax(0,1fr)_304px]">
        <aside className="hidden lg:block">
          <div className="sticky top-[4.5rem] flex max-h-[calc(100vh-4.5rem)] flex-col gap-4 overflow-y-auto py-5 pl-5">
            <section className="panel space-y-3 rounded-[1.25rem] p-4">
              <p className="section-eyebrow px-1">Fields</p>
              <div className="grid gap-2">
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

            <section className="panel space-y-3 rounded-[1.25rem] p-4">
              <div className="flex items-center justify-between px-1">
                <p className="section-eyebrow">Signers</p>
                <span className="text-xs font-medium text-(--tertiary)">
                  {fields.length === 1
                    ? "1 field placed"
                    : `${String(fields.length)} fields placed`}
                </span>
              </div>
              <div className="space-y-2">
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

        <section className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
          <div className="panel rounded-[1.25rem] px-4 py-3">
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
                  className="btn-quiet size-10 px-0"
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
                <div className="min-w-[7.5rem] text-center">
                  <p className="sr-only">Document page</p>
                  <p className="text-sm font-bold text-(--fg)">
                    {`Page ${activePage} of ${pageCount}`}
                  </p>
                </div>
                <button
                  aria-label="Next page"
                  className="btn-quiet size-10 px-0"
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

          <div className="panel rounded-[1.25rem] p-4 lg:hidden">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <label className="grid flex-1 gap-1.5">
                <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                  Selected signer
                </span>
                <select
                  aria-label="Selected signer"
                  className="field-input"
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
              <Button
                className="min-h-12"
                onClick={() => setIsMobileToolsOpen(true)}
                type="button"
                variant="secondary"
              >
                Open field tools
              </Button>
            </div>
          </div>

          <div className="panel overflow-hidden rounded-[1.25rem]">
            <div
              className={`relative overflow-auto p-3 sm:p-6 ${
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
                  className="relative overflow-hidden rounded-md bg-white shadow-[0_1px_2px_rgba(28,29,43,0.08),0_12px_32px_rgba(28,29,43,0.12)]"
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
                        className="absolute inset-0 z-10 cursor-copy bg-transparent"
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
                        <div className="max-w-[300px] rounded-[1.25rem] border-2 border-dashed border-(--border-strong) bg-white/92 px-6 py-7 text-center">
                          <p className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                            No fields placed yet
                          </p>
                          <p className="mt-2 text-sm leading-6 text-(--secondary)">
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
                      <div className="pointer-events-none absolute inset-x-4 bottom-4 z-11 rounded-2xl bg-white/95 px-4 py-3 shadow-(--shadow-lift) ring-1 ring-[rgba(83,64,214,0.18)] sm:inset-x-6 sm:bottom-6">
                        <p className="text-[0.8125rem] font-bold text-(--accent-ink)">
                          Ready to place
                        </p>
                        <p className="mt-1 text-sm text-(--secondary)">
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
            <div className="panel rounded-[1.25rem] p-4 lg:hidden">
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

        <aside className="hidden lg:block">
          <div className="sticky top-[4.5rem] flex max-h-[calc(100vh-4.5rem)] flex-col gap-4 overflow-y-auto py-5 pr-5">
            <section className="panel space-y-3 rounded-[1.25rem] p-4">
              <p className="section-eyebrow px-1">Inspector</p>
              <div>
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
            className="absolute inset-0 bg-[rgba(28,29,43,0.32)]"
            onClick={() => setIsMobileToolsOpen(false)}
            type="button"
          />
          <div
            aria-label="Field tools"
            className="absolute inset-x-0 bottom-0 rounded-t-[1.75rem] bg-white px-4 py-5 shadow-[0_-24px_60px_rgba(28,29,43,0.18)]"
            role="dialog"
          >
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-(--surface-strong)" />
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="section-eyebrow">Fields</p>
                <button
                  className="text-sm font-bold text-(--accent-ink)"
                  onClick={() => setIsMobileToolsOpen(false)}
                  type="button"
                >
                  Done
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
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

const fieldToolIcons: Record<PrepareFieldType, LucideIcon> = {
  checkbox: SquareCheckIcon,
  date: CalendarIcon,
  initials: CaseSensitiveIcon,
  signature: SignatureIcon,
  text: TypeIcon,
};

function FieldToolButton({ isActive, onSelect, tool }: FieldToolButtonProps) {
  const Icon = fieldToolIcons[tool.type];

  return (
    <button
      aria-label={tool.label}
      aria-pressed={isActive}
      className={`flex min-h-12 items-center gap-3 rounded-[0.875rem] px-2.5 text-left text-sm font-bold transition ${
        isActive
          ? "bg-(--accent) text-white shadow-(--shadow-sm)"
          : "bg-(--surface) text-(--fg) hover:bg-(--accent-softer) hover:text-(--accent-ink)"
      }`}
      onClick={onSelect}
      type="button"
    >
      <span
        aria-hidden="true"
        className={`inline-flex size-8 shrink-0 items-center justify-center rounded-[0.625rem] ${
          isActive ? "bg-white/20 text-white" : "bg-white text-(--accent)"
        }`}
      >
        <Icon className="size-4" strokeWidth={2.2} />
      </span>
      <span className="flex-1">{tool.label}</span>
      <span
        className={`pr-1.5 text-xs font-semibold ${
          isActive ? "text-white/85" : "text-(--tertiary)"
        }`}
      >
        {isActive ? "Placing" : "Place"}
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
      className={`w-full rounded-[0.875rem] px-3 py-3 text-left transition ${
        isActive
          ? "bg-(--accent-softer) ring-2 ring-(--accent)"
          : "bg-(--surface) hover:bg-(--accent-softer)"
      }`}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[0.8125rem] font-bold"
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
          <p className="truncate text-sm font-bold text-(--fg)">{signer.name}</p>
          <p className="mt-0.5 text-xs text-(--secondary)">
            {fieldCount} field{fieldCount === 1 ? "" : "s"} placed
          </p>
          <p
            className={`mt-1.5 text-xs font-bold ${
              hasSignatureField ? "text-(--success)" : "text-(--danger)"
            }`}
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
    <div className="well px-4 py-4">
      <p className="text-sm font-bold text-(--fg)">
        {activeTool ? `${activeTool.label} ready to place` : "No field selected"}
      </p>
      <p className="mt-1.5 text-sm leading-6 text-(--secondary)">
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
    <section className="panel space-y-3 rounded-[1.25rem] p-4">
      <p className="section-eyebrow px-1">Selected signer</p>
      <div className="flex items-center gap-3 px-1">
        <span
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold"
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
          <p className="truncate text-sm font-bold text-(--fg)">
            {selectedSigner.name}
          </p>
          <p className="mt-0.5 text-[0.8125rem] text-(--secondary)">
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
      className={`inline-flex min-h-10 items-center gap-2.5 rounded-full px-3.5 py-1.5 text-[0.8125rem] ${
        isError ? "bg-(--danger-soft)" : "bg-(--surface)"
      }`}
      role={isError ? "alert" : "status"}
    >
      <span
        aria-hidden="true"
        className={`inline-flex size-5 items-center justify-center rounded-full ${
          isError
            ? "bg-white text-(--danger)"
            : isSaving
              ? "text-(--secondary)"
              : "bg-(--success-soft) text-(--success)"
        }`}
      >
        {isError ? (
          <span className="text-[13px] font-bold leading-none">!</span>
        ) : isSaving ? (
          <span className="size-3.5 animate-spin rounded-full border-2 border-(--border-strong) border-t-(--accent)" />
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
        <p className="font-bold text-(--fg)">
          {isError ? "Save failed" : isSaving ? "Saving..." : "Saved"}
        </p>
        {saveError ? (
          <p className="truncate text-xs text-(--danger)">{saveError}</p>
        ) : null}
      </div>
      {isError ? (
        <button
          className="btn-quiet btn-quiet-danger min-h-8 px-3 text-xs"
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
      <div className="px-1">
        <p className="section-eyebrow">Field settings</p>
        <p className="mt-1 text-base font-extrabold text-(--fg)">
          {tool.label}
        </p>
      </div>

      <div className="mt-4 space-y-4">
        <div>
          <p className="px-1 text-[0.8125rem] font-semibold text-(--secondary)">
            Assigned to
          </p>
          <div className="mt-2 grid gap-2">
            {signers.map((signer) => {
              const isAssigned = field.signerId === signer.id;

              return (
                <button
                  aria-pressed={isAssigned}
                  className={`flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-left text-sm font-bold transition ${
                    isAssigned
                      ? "bg-(--accent-softer) text-(--fg) ring-2 ring-(--accent)"
                      : "bg-(--surface) text-(--fg) hover:bg-(--accent-softer)"
                  }`}
                  key={signer.id}
                  onClick={() => onSignerChange(signer.id)}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: signer.color }}
                  />
                  <span className="truncate">{signer.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {isOptionalField ? (
          <div>
            <p className="px-1 text-[0.8125rem] font-semibold text-(--secondary)">
              Required
            </p>
            <div className="segmented mt-2 flex w-full">
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
                  aria-pressed={field.required === option.value}
                  className="segmented-item flex-1"
                  key={option.label}
                  onClick={() => onSetRequired(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <Button
          className="w-full bg-(--danger-soft) text-(--danger) hover:bg-[#fbd9d6]"
          onClick={onDelete}
          type="button"
          variant="ghost"
        >
          Delete
        </Button>
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
