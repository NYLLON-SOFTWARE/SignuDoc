"use client";

import { FileTextIcon, UploadIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StepIndicator } from "@/components/shared/step-indicator";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { cacheDraftPdfBlob } from "@/lib/draft-pdf-cache";
import {
  renderPdfThumbnail,
  uploadEnvelopeThumbnail,
} from "@/lib/pdf-thumbnail";
import { assertPdfPreviewRenderable } from "@/lib/pdfjs-client";
import { type CreateEnvelopeResponse } from "@/lib/schemas/envelope";

const envelopeSteps = ["Upload", "Signers", "Place fields", "Review"];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

type UploadErrorCode = "invalid-type" | "preview-unavailable" | "too-large";

type UploadSummary = {
  file: File;
  fileName: string;
  sizeLabel: string;
};

const errorMessageMap: Record<UploadErrorCode, string> = {
  "invalid-type": "Only PDF files are supported. Please upload a valid PDF.",
  "preview-unavailable":
    "We couldn't render this PDF in the editor. Please export it as a standard PDF and try again.",
  "too-large": "This file exceeds the 20 MB limit.",
};

const knownTitleSuggestions: Record<string, string> = {
  "nda-clientbravo-2026.pdf": "NDA - Client Bravo",
  "nda-client-bravo-2026.pdf": "NDA - Client Bravo",
  "vendor-agreement-two-signer.pdf": "Vendor agreement - two signer flow",
};

function formatFileSize(sizeInBytes: number) {
  const sizeInMegabytes = sizeInBytes / (1024 * 1024);

  if (sizeInMegabytes >= 1) {
    return `${sizeInMegabytes.toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(sizeInBytes / 1024))} KB`;
}

function makeTitleSuggestion(fileName: string) {
  return fileName
    .replace(/\.pdf$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTitleSuggestion(fileName: string): string {
  const normalizedName = fileName.toLowerCase();
  const knownTitleSuggestion = knownTitleSuggestions[normalizedName];

  if (knownTitleSuggestion) {
    return knownTitleSuggestion;
  }

  return makeTitleSuggestion(fileName);
}

function isClientVisiblePdf(file: File): boolean {
  const normalizedName = file.name.toLowerCase();

  return (
    normalizedName.endsWith(".pdf") &&
    (file.type.length === 0 || file.type === "application/pdf")
  );
}

function UploadShellLayout({
  canContinue,
  errorMessage,
  isBusy,
  isDragActive,
  isSubmitting = false,
  onDropzoneKeyDown,
  onOpenFilePicker,
  onRemoveFile,
  onTitleChange,
  onContinue,
  previewUrl,
  summary,
  title,
}: {
  canContinue: boolean;
  errorMessage: string | null;
  isBusy: boolean;
  isDragActive: boolean;
  isSubmitting?: boolean;
  onContinue?: () => void;
  onDropzoneKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onOpenFilePicker: () => void;
  onRemoveFile: () => void;
  onTitleChange: (event: ChangeEvent<HTMLInputElement>) => void;
  previewUrl: string | null;
  summary: UploadSummary | null;
  title: string;
}) {
  const dropzoneClasses = isBusy
    ? "border-(--accent) bg-(--accent-softer)"
    : errorMessage
      ? "border-[rgba(180,35,24,0.4)] bg-(--danger-soft)"
      : isDragActive
        ? "border-(--accent) bg-(--accent-softer)"
        : "border-(--border-strong) bg-(--surface) hover:border-(--accent) hover:bg-(--accent-softer)";

  return (
    <div className="space-y-5">
      <PageHeader
        action={
          <Link className="btn-quiet min-h-11 px-4" href="/templates">
            Start from a template
          </Link>
        }
        description="Step 1 of 4 - Upload document"
        title="New envelope"
      />

      <StepIndicator current={1} steps={envelopeSteps} />

      <section
        className="panel p-5 sm:p-8"
        data-animate="enter"
        data-animate-delay="2"
      >
        <div className="space-y-6">
          <FieldShell
            label="Envelope title"
            onChange={onTitleChange}
            placeholder="e.g., NDA - Client Bravo"
            readOnly={false}
            value={title}
          />

          <div
            aria-busy={isBusy}
            aria-label="Document upload dropzone"
            className={cn(
              "cursor-pointer rounded-[1.25rem] border-2 border-dashed px-6 py-10 text-center transition sm:px-10 sm:py-12",
              dropzoneClasses,
            )}
            onClick={onOpenFilePicker}
            onDragLeave={isBusy ? undefined : () => undefined}
            onDragOver={undefined}
            onDrop={undefined}
            onKeyDown={onDropzoneKeyDown}
            role="button"
            tabIndex={0}
          >
            <div className="mx-auto flex max-w-xl flex-col items-center gap-4">
              {isBusy ? (
                <>
                  <div
                    aria-label="Upload progress"
                    className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-white"
                    role="progressbar"
                  >
                    <div className="h-full w-2/3 animate-pulse rounded-full bg-(--accent)" />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-lg font-bold tracking-[-0.02em] text-(--fg)">
                      Uploading...
                    </p>
                    <p className="text-sm leading-6 text-(--secondary)">
                      Validating the PDF before you continue to signer setup.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-(--accent-soft) text-(--accent)">
                    <UploadIcon
                      aria-hidden="true"
                      className="size-5"
                      strokeWidth={2.2}
                    />
                  </span>
                  <div className="space-y-1.5">
                    <p className="text-lg font-bold tracking-[-0.02em] text-(--fg)">
                      Drag and drop your PDF here
                    </p>
                    <p className="text-sm text-(--secondary)">
                      or{" "}
                      <span className="font-bold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4">
                        click to browse
                      </span>
                    </p>
                  </div>
                  <p className="text-[0.8125rem] font-medium text-(--tertiary)">
                    PDF only - 20 MB max
                  </p>
                </>
              )}
            </div>
          </div>

          {errorMessage ? (
            <div
              className="rounded-2xl bg-(--danger-soft) px-5 py-4"
              role="alert"
            >
              <p className="text-sm font-semibold text-(--danger)">
                {errorMessage}
              </p>
            </div>
          ) : null}

          {summary ? (
            <section className="well flex items-center gap-4 p-3.5 pr-4">
              <span className="flex h-[4.5rem] w-14 shrink-0 items-center justify-center">
                {previewUrl ? (
                  // A blob: URL drawn in this browser from the chosen file.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt=""
                    className="max-h-full max-w-full rounded-[0.375rem] bg-white shadow-[0_1px_2px_rgba(28,29,43,0.08),0_4px_10px_rgba(28,29,43,0.10)] ring-1 ring-[rgba(28,29,43,0.06)]"
                    src={previewUrl}
                  />
                ) : (
                  <span className="inline-flex size-11 items-center justify-center rounded-xl bg-white text-(--accent)">
                    <FileTextIcon aria-hidden="true" className="size-5" />
                  </span>
                )}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate text-sm font-bold text-(--fg)">
                  {summary.fileName}
                </p>
                <p className="text-[0.8125rem] text-(--tertiary)">
                  {summary.sizeLabel}
                </p>
              </div>
              <Button
                onClick={onRemoveFile}
                size="sm"
                type="button"
                variant="outline"
              >
                Remove
              </Button>
            </section>
          ) : null}

          <div className="flex justify-end">
            <ShellButton
              disabled={!canContinue}
              loading={isSubmitting}
              onClick={onContinue}
            >
              Next -&gt;
            </ShellButton>
          </div>
        </div>
      </section>
    </div>
  );
}

// Sends the PDF straight to Vercel Blob with a signed URL from /api/uploads,
// then tells the app where it is. The Blob SDK is loaded only when used.
async function createDraftFromDirectUpload(input: {
  file: File;
  title: string;
  uploadPrefix: string;
}) {
  const { uploadPresigned } = await import("@vercel/blob/client");
  const uploadKey = `${input.uploadPrefix}${crypto.randomUUID()}.pdf`;

  await uploadPresigned(uploadKey, input.file, {
    access: "private",
    contentType: "application/pdf",
    handleUploadUrl: "/api/uploads",
  });

  return fetch("/api/envelopes", {
    body: JSON.stringify({
      filename: input.file.name,
      title: input.title,
      uploadKey,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function createDraftFromForm(input: { file: File; title: string }) {
  const formData = new FormData();

  formData.append("file", input.file);
  formData.append("title", input.title);

  return fetch("/api/envelopes", {
    body: formData,
    method: "POST",
  });
}

type UploadShellProps = {
  /**
   * Where this user's browser may upload directly, ending in a slash, or
   * null when uploads go through the app.
   */
  directUploadPrefix?: string | null;
};

export function UploadShell({ directUploadPrefix = null }: UploadShellProps) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCreatingDraft, setIsCreatingDraft] = useState(false);
  const [autoFilledTitle, setAutoFilledTitle] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The first page of the chosen file as a small picture: shown beside the
  // file name here, then saved as the envelope's dashboard thumbnail.
  const thumbnailRef = useRef<Promise<Blob | null> | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  function startThumbnail(file: File | null) {
    setPreviewUrl(null);

    if (!file) {
      thumbnailRef.current = null;
      return;
    }

    const thumbnail = file
      .arrayBuffer()
      .then((buffer) => renderPdfThumbnail(new Uint8Array(buffer)))
      .catch(() => null);

    thumbnailRef.current = thumbnail;

    void thumbnail.then((blob) => {
      if (blob && thumbnailRef.current === thumbnail) {
        setPreviewUrl(URL.createObjectURL(blob));
      }
    });
  }

  function resetSelection(clearTitle: boolean) {
    startThumbnail(null);
    setSummary(null);
    setErrorMessage(null);
    setIsCreatingDraft(false);

    if (clearTitle) {
      setTitle((currentTitle) =>
        autoFilledTitle && currentTitle === autoFilledTitle ? "" : currentTitle,
      );
    }

    setAutoFilledTitle(null);
  }

  async function parseResponse<T>(
    response: Response,
  ): Promise<{ data: T | null; error: string | null }> {
    const payload = (await response.json().catch(() => null)) as
      { error?: string } | T | null;

    if (!response.ok) {
      return {
        data: null,
        error:
          payload && typeof payload === "object" && "error" in payload
            ? (payload.error ?? "Something went wrong. Please try again.")
            : "Something went wrong. Please try again.",
      };
    }

    return {
      data: payload as T,
      error: null,
    };
  }

  function beginUpload(file: File) {
    if (!isClientVisiblePdf(file)) {
      setErrorMessage(errorMessageMap["invalid-type"]);
      setSummary(null);
      startThumbnail(null);
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setErrorMessage(errorMessageMap["too-large"]);
      setSummary(null);
      startThumbnail(null);
      return;
    }

    startThumbnail(file);

    const titleSuggestion = getTitleSuggestion(file.name);

    setSummary({
      file,
      fileName: file.name,
      sizeLabel: formatFileSize(file.size),
    });
    setErrorMessage(null);

    if (title.trim().length === 0) {
      setTitle(titleSuggestion);
      setAutoFilledTitle(titleSuggestion);
    }
  }

  function handleFileSelection(file: File | null) {
    setIsDragActive(false);

    if (!file) {
      return;
    }

    beginUpload(file);
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] ?? null;
    handleFileSelection(selectedFile);
    event.target.value = "";
  }

  function handleRemoveFile() {
    resetSelection(true);
  }

  function handleTitleChange(event: ChangeEvent<HTMLInputElement>) {
    const nextTitle = event.target.value;
    setTitle(nextTitle);

    if (autoFilledTitle && nextTitle !== autoFilledTitle) {
      setAutoFilledTitle(null);
    }
  }

  function openFilePicker() {
    if (isCreatingDraft) {
      return;
    }

    fileInputRef.current?.click();
  }

  function handleDropzoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFilePicker();
    }
  }

  async function handleContinue() {
    if (isCreatingDraft || !summary || title.trim().length === 0) {
      return;
    }

    setIsCreatingDraft(true);
    setErrorMessage(null);

    // Taken now, with the file. The file can still be removed and another
    // chosen while the draft is being created, and that one's picture must
    // not end up on this draft.
    const thumbnailForDraft = thumbnailRef.current;

    try {
      try {
        await assertPdfPreviewRenderable(summary.file);
      } catch (error) {
        console.error(
          "Failed to validate the PDF preview before draft creation.",
          error,
        );
        setErrorMessage(errorMessageMap["preview-unavailable"]);
        setIsCreatingDraft(false);
        return;
      }

      const draftInput = { file: summary.file, title: title.trim() };
      const response = directUploadPrefix
        ? await createDraftFromDirectUpload({
            ...draftInput,
            uploadPrefix: directUploadPrefix,
          })
        : await createDraftFromForm(draftInput);
      const payload = await parseResponse<CreateEnvelopeResponse>(response);

      if (!payload.data || payload.error) {
        setErrorMessage(
          payload.error ?? "Something went wrong. Please try again.",
        );

        if (response.status === 400) {
          setSummary(null);
          startThumbnail(null);
        }

        setIsCreatingDraft(false);
        return;
      }

      try {
        await cacheDraftPdfBlob(payload.data.envelopeId, summary.file);
      } catch (error) {
        console.error(
          "Failed to cache the uploaded PDF for local preview.",
          error,
        );
      }

      // Not waited for: the dashboard draws one later if this is lost.
      const createdEnvelopeId = payload.data.envelopeId;

      void thumbnailForDraft?.then((thumbnail) =>
        thumbnail
          ? uploadEnvelopeThumbnail(createdEnvelopeId, thumbnail)
          : false,
      );

      const redirectPath = payload.data.redirectPath;

      startTransition(() => {
        router.push(redirectPath);
      });
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
      setIsCreatingDraft(false);
    }
  }

  const canContinue =
    !isCreatingDraft && summary != null && title.trim().length > 0;

  return (
    <div
      onDragLeave={() => setIsDragActive(false)}
      onDragOver={(event) => {
        event.preventDefault();
        if (!isCreatingDraft) {
          setIsDragActive(true);
        }
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();

        if (isCreatingDraft) {
          return;
        }

        handleFileSelection(event.dataTransfer.files?.[0] ?? null);
      }}
    >
      <input
        accept=".pdf,application/pdf"
        aria-label="Upload PDF"
        className="sr-only"
        onChange={handleInputChange}
        ref={fileInputRef}
        type="file"
      />
      <UploadShellLayout
        canContinue={canContinue}
        errorMessage={errorMessage}
        isBusy={isCreatingDraft}
        isDragActive={isDragActive}
        isSubmitting={isCreatingDraft}
        onContinue={handleContinue}
        onDropzoneKeyDown={handleDropzoneKeyDown}
        onOpenFilePicker={openFilePicker}
        onRemoveFile={handleRemoveFile}
        onTitleChange={handleTitleChange}
        previewUrl={previewUrl}
        summary={summary}
        title={title}
      />
    </div>
  );
}
