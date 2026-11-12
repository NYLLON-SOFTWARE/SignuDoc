import {
  DownloadAccessError,
  type EnvelopeDownloadResult,
} from "./downloads.ts";
import {
  buildContentDisposition,
  createStorageService,
  StorageObjectNotFoundError,
  type StorageService,
} from "./services/storage.ts";

type CreateDownloadResponseOptions = {
  storageService?: StorageService;
};

/**
 * Turns a resolved download into an HTTP response. Stored files are streamed
 * straight from storage so the function never buffers a whole PDF, which keeps
 * large files clear of serverless response-size limits.
 */
export async function createDownloadResponse(
  download: EnvelopeDownloadResult,
  { storageService }: CreateDownloadResponseOptions = {},
): Promise<Response> {
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-disposition": buildContentDisposition(download.fileName),
    "content-type": download.contentType,
    "x-content-type-options": "nosniff",
  });

  if ("body" in download) {
    headers.set("content-length", String(download.contentLength));

    return new Response(download.body.slice().buffer as ArrayBuffer, {
      headers,
      status: 200,
    });
  }

  try {
    const object = await (
      storageService ?? createStorageService()
    ).getObjectStream(download.key);

    if (typeof object.contentLength === "number") {
      headers.set("content-length", String(object.contentLength));
    }

    return new Response(object.stream, { headers, status: 200 });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new DownloadAccessError("This file is no longer available.", 404);
    }

    throw error;
  }
}
