import { loadPdfJsModule, PDF_JS_STANDARD_FONT_DATA_URL } from "./pdfjs-client";

// Draws the first page of a PDF as a small JPEG, in the browser. The server
// never renders PDFs, so this is where a document's dashboard thumbnail
// comes from: once at upload, or later for an envelope that has none.

const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_MAX_HEIGHT = 960;
const THUMBNAIL_QUALITY = 0.82;

export function buildEnvelopeThumbnailUrl(envelopeId: string): string {
  return `/api/envelopes/${encodeURIComponent(envelopeId)}/thumbnail`;
}

export async function renderPdfThumbnail(
  source: Uint8Array | { url: string },
): Promise<Blob> {
  const pdfjs = await loadPdfJsModule();
  const loadingTask = pdfjs.getDocument(
    source instanceof Uint8Array
      ? {
          // pdf.js takes ownership of the buffer it is given.
          data: source.slice(),
          standardFontDataUrl: PDF_JS_STANDARD_FONT_DATA_URL,
        }
      : {
          standardFontDataUrl: PDF_JS_STANDARD_FONT_DATA_URL,
          url: source.url,
        },
  );

  try {
    const documentProxy = await loadingTask.promise;
    const page = await documentProxy.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
      THUMBNAIL_WIDTH / baseViewport.width,
      THUMBNAIL_MAX_HEIGHT / baseViewport.height,
    );
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");

    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));

    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to create a thumbnail canvas.");
    }

    // A JPEG has no transparency: without this a page with no background
    // of its own would come out black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, canvasContext: context, viewport }).promise;
    page.cleanup();

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Unable to encode the thumbnail."));
          }
        },
        "image/jpeg",
        THUMBNAIL_QUALITY,
      );
    });
  } finally {
    await loadingTask.destroy();
  }
}

/** Stores a thumbnail for an envelope. Resolves to whether it was kept. */
export async function uploadEnvelopeThumbnail(
  envelopeId: string,
  thumbnail: Blob,
): Promise<boolean> {
  try {
    const response = await fetch(buildEnvelopeThumbnailUrl(envelopeId), {
      body: thumbnail,
      headers: { "content-type": "image/jpeg" },
      method: "PUT",
    });

    return response.ok;
  } catch {
    return false;
  }
}

// A dashboard full of envelopes without thumbnails would otherwise download
// and draw every PDF at once.
let backfillQueue: Promise<unknown> = Promise.resolve();

/**
 * Makes the thumbnail for an envelope that has none, from its stored PDF,
 * and saves it for next time. One document at a time.
 */
export function backfillEnvelopeThumbnail(envelopeId: string): Promise<Blob> {
  const result = backfillQueue.then(async () => {
    const thumbnail = await renderPdfThumbnail({
      url: `/api/envelopes/${encodeURIComponent(envelopeId)}/document`,
    });

    void uploadEnvelopeThumbnail(envelopeId, thumbnail);

    return thumbnail;
  });

  backfillQueue = result.catch(() => undefined);

  return result;
}
