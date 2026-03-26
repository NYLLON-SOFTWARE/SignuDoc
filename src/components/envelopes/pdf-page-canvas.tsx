"use client";

import { useEffect, useRef, useState } from "react";

import {
  loadPdfJsModule,
  PDF_JS_STANDARD_FONT_DATA_URL,
} from "@/lib/pdfjs-client";

type PdfJsModule = Awaited<ReturnType<typeof loadPdfJsModule>>;
type PdfDocumentProxy = Awaited<
  ReturnType<PdfJsModule["getDocument"]>["promise"]
>;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;
type PdfRenderTask = ReturnType<PdfPageProxy["render"]>;
export type PdfPageRenderState = "error" | "loading" | "ready";

type PdfPageCanvasProps = {
  documentUrl: string | null;
  onRenderStateChange?: (state: PdfPageRenderState) => void;
  pageNumber: number;
};

export function PdfPageCanvas({
  documentUrl,
  onRenderStateChange,
  pageNumber,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [documentProxy, setDocumentProxy] = useState<PdfDocumentProxy | null>(
    null,
  );
  const [viewportSize, setViewportSize] = useState({
    height: 0,
    width: 0,
  });
  const [renderState, setRenderState] = useState<PdfPageRenderState>("loading");

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const viewportCandidate = canvas.closest("[data-field-viewport]");

    if (!(viewportCandidate instanceof HTMLElement)) {
      return;
    }

    const viewportElement: HTMLElement = viewportCandidate;

    function updateViewportSize() {
      const nextWidth = Math.round(viewportElement.clientWidth);
      const nextHeight = Math.round(viewportElement.clientHeight);

      if (nextWidth === 0 || nextHeight === 0) {
        return;
      }

      setViewportSize((currentSize) =>
        currentSize.width === nextWidth && currentSize.height === nextHeight
          ? currentSize
          : {
              height: nextHeight,
              width: nextWidth,
            },
      );
    }

    updateViewportSize();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewportSize);

      return () => {
        window.removeEventListener("resize", updateViewportSize);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      updateViewportSize();
    });

    resizeObserver.observe(viewportElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    let activeDocument: PdfDocumentProxy | null = null;
    let loadingTask: ReturnType<PdfJsModule["getDocument"]> | null = null;

    async function loadDocument() {
      setRenderState("loading");
      setDocumentProxy(null);

      if (!documentUrl) {
        return;
      }

      try {
        const pdfjs = await loadPdfJsModule();
        loadingTask = pdfjs.getDocument({
          standardFontDataUrl: PDF_JS_STANDARD_FONT_DATA_URL,
          url: documentUrl,
        });
        const nextDocument = await loadingTask.promise;

        if (!isActive) {
          await nextDocument.destroy();
          return;
        }

        activeDocument = nextDocument;
        setDocumentProxy(nextDocument);
      } catch (error) {
        if (isActive) {
          console.error("Failed to load the PDF preview document.", error);
          setDocumentProxy(null);
          setRenderState("error");
        }
      }
    }

    void loadDocument();

    return () => {
      isActive = false;
      loadingTask?.destroy();
      void activeDocument?.destroy();
    };
  }, [documentUrl]);

  useEffect(() => {
    if (
      !documentProxy ||
      !canvasRef.current ||
      viewportSize.width === 0 ||
      viewportSize.height === 0
    ) {
      return;
    }

    let isActive = true;
    let activePage: PdfPageProxy | null = null;
    let renderTask: PdfRenderTask | null = null;

    async function renderPage() {
      setRenderState("loading");

      try {
        const page = await documentProxy.getPage(pageNumber);

        if (!isActive) {
          page.cleanup();
          return;
        }

        activePage = page;

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(
          viewportSize.width / baseViewport.width,
          viewportSize.height / baseViewport.height,
        );
        const viewport = page.getViewport({ scale });
        const outputScale = window.devicePixelRatio || 1;
        const canvas = canvasRef.current;

        if (!canvas) {
          return;
        }

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Unable to render PDF canvas context.");
        }

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);

        renderTask = page.render({
          canvasContext: context,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
          viewport,
        });

        await renderTask.promise;

        if (!isActive) {
          return;
        }

        setRenderState("ready");
      } catch (error) {
        if (
          isActive &&
          (!error ||
            typeof error !== "object" ||
            !("name" in error) ||
            error.name !== "RenderingCancelledException")
        ) {
          console.error("Failed to render the PDF preview page.", error);
          setRenderState("error");
        }
      }
    }

    void renderPage();

    return () => {
      isActive = false;
      renderTask?.cancel();
      activePage?.cleanup();
    };
  }, [documentProxy, pageNumber, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    onRenderStateChange?.(renderState);
  }, [onRenderStateChange, renderState]);

  return (
    <div
      aria-label={`Rendered PDF page ${pageNumber}`}
      className="absolute inset-0 flex items-center justify-center"
      role="img"
    >
      <canvas
        className={`max-h-full max-w-full ${
          renderState === "ready" ? "opacity-100" : "opacity-0"
        }`}
        ref={canvasRef}
      />
      {renderState !== "ready" ? (
        <div className="absolute inset-0 z-1 flex items-center justify-center rounded-[28px] bg-white/92 px-6 text-center">
          <div className="max-w-[320px] rounded-[24px] border border-(--border) bg-(--surface) px-5 py-4 shadow-(--shadow-card)">
            <p className="text-sm font-semibold text-(--fg)">
              {renderState === "error"
                ? "We couldn't render this PDF page."
                : "Rendering document page..."}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {renderState === "error"
                ? "Reload the page or try this draft again in a moment."
                : "Preparing the source PDF so placed fields stay aligned with the stored page size."}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
