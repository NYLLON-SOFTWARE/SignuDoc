import { MAX_UPLOAD_SIZE_BYTES } from "../types/domain.ts";
import { DocumentImportError } from "./document-import.ts";
import {
  StorageObjectNotFoundError,
  type StorageService,
} from "./storage/types.ts";
import { isPendingUploadKey } from "./storage-keys.ts";

// A pending upload is a PDF the browser sent straight to storage (see
// direct-upload.ts). Nothing about it is trusted. The app reads it back
// with a hard size cap, validates it like any other upload, stores its own
// copy under the envelope's key, and deletes the pending one.

export class PendingUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingUploadError";
  }
}

type PendingUploadInput = {
  key: string;
  storageService: StorageService;
};

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        throw new DocumentImportError("too_large");
      }

      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);

    throw error;
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

/**
 * Reads a user's pending upload into memory. Refuses a key that is not in
 * that user's pending folder, and stops reading at the upload size limit
 * whatever size the storage reports.
 */
export async function readPendingUpload({
  key,
  maxBytes = MAX_UPLOAD_SIZE_BYTES,
  storageService,
  userId,
}: PendingUploadInput & {
  maxBytes?: number;
  userId: string;
}): Promise<Uint8Array> {
  if (!isPendingUploadKey(key, userId)) {
    throw new PendingUploadError("Invalid upload reference.");
  }

  try {
    const object = await storageService.getObjectStream(key);

    if (object.contentLength !== undefined && object.contentLength > maxBytes) {
      await object.stream.cancel().catch(() => undefined);

      throw new DocumentImportError("too_large");
    }

    return await readStreamWithLimit(object.stream, maxBytes);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new PendingUploadError(
        "The uploaded file was not found. Please upload it again.",
      );
    }

    throw error;
  }
}

/**
 * Deletes a pending upload once it has been dealt with. Never throws: one
 * that cannot be deleted now is removed by the storage's own expiry.
 */
export async function discardPendingUpload({
  key,
  storageService,
}: PendingUploadInput): Promise<void> {
  try {
    await storageService.deleteObject(key);
  } catch (error) {
    console.warn("Could not delete a pending upload.", error);
  }
}
