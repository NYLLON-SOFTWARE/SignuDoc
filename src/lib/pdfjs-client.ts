type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocumentProxy = Awaited<
  ReturnType<PdfJsModule["getDocument"]>["promise"]
>;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;
type PdfRenderTask = ReturnType<PdfPageProxy["render"]>;

const PDF_JS_ASSET_BASE = "/pdfjs/5.5.207";
export const PDF_JS_STANDARD_FONT_DATA_URL =
  `${PDF_JS_ASSET_BASE}/standard_fonts/`;
export const PDF_JS_WORKER_SRC =
  `${PDF_JS_ASSET_BASE}/legacy/build/pdf.worker.min.mjs`;

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function createRenderContext(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to create an offscreen PDF preview context.");
    }

    return context;
  }

  if (typeof document === "undefined") {
    throw new Error("Unable to create a PDF preview context.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create a PDF preview context.");
  }

  return context;
}

export async function loadPdfJsModule(): Promise<PdfJsModule> {
  pdfJsModulePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_SRC;

    return pdfjs;
  });

  return pdfJsModulePromise;
}

export async function assertPdfPreviewRenderable(
  file: File | Uint8Array,
): Promise<void> {
  const pdfBytes =
    file instanceof Uint8Array ? file.slice() : new Uint8Array(await file.arrayBuffer());
  const pdfjs = await loadPdfJsModule();
  let loadingTask: ReturnType<PdfJsModule["getDocument"]> | null = null;
  let documentProxy: PdfDocumentProxy | null = null;
  let page: PdfPageProxy | null = null;
  let renderTask: PdfRenderTask | null = null;

  try {
    loadingTask = pdfjs.getDocument({
      data: pdfBytes,
      standardFontDataUrl: PDF_JS_STANDARD_FONT_DATA_URL,
    });
    documentProxy = await loadingTask.promise;
    page = await documentProxy.getPage(1);

    const viewport = page.getViewport({ scale: 1 });
    const renderContext = createRenderContext(
      Math.max(1, Math.ceil(viewport.width)),
      Math.max(1, Math.ceil(viewport.height)),
    );

    renderTask = page.render({
      canvasContext: renderContext as CanvasRenderingContext2D,
      viewport,
    });

    await renderTask.promise;
  } finally {
    renderTask?.cancel();
    page?.cleanup();
    loadingTask?.destroy();

    if (documentProxy) {
      await documentProxy.destroy();
    }
  }
}
