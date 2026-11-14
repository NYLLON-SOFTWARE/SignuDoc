export type StorageObjectRef = {
  bucketName: string;
  key: string;
};

export type StorageObject = StorageObjectRef & {
  body: Uint8Array;
  contentLength?: number;
  contentType?: string;
  etag?: string;
};

export type StorageObjectStream = StorageObjectRef & {
  contentLength?: number;
  contentType?: string;
  stream: ReadableStream<Uint8Array>;
};

export type StorageObjectHead = StorageObjectRef & {
  contentLength?: number;
  contentType?: string;
  etag?: string;
  exists: boolean;
};

export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageObjectNotFoundError";
  }
}

export interface StorageService {
  deleteObject(key: string): Promise<void>;
  /** Reads the whole object into memory. Use for processing, not for downloads. */
  getObject(key: string): Promise<StorageObject>;
  /** Streams the object. Use for responses so large files are never buffered. */
  getObjectStream(key: string): Promise<StorageObjectStream>;
  headObject(key: string): Promise<StorageObjectHead>;
  putObject(input: {
    body: Uint8Array;
    contentType: string;
    key: string;
    /**
     * Leave an object that is already stored under this key as it is. The
     * store itself refuses the second write, so of two writers that arrive
     * together exactly one is kept. Without this, a write replaces what is
     * there.
     */
    keepExisting?: boolean;
  }): Promise<StorageObjectRef>;
}

export function normalizeStorageKey(key: string): string {
  const normalizedKey = key.trim().replaceAll("\\", "/").replace(/^\/+/, "");

  if (normalizedKey.length === 0) {
    throw new Error("Storage key is required.");
  }

  const segments = normalizedKey.split("/");

  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Storage key is invalid.");
  }

  return normalizedKey;
}
