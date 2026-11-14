import { BlobNotFoundError, del, get, head, put } from "@vercel/blob";

import { type EnvSource } from "../../utils/env.ts";
import { ServiceConfigurationError } from "../service-config.ts";
import { hasBlobCredentials } from "./driver.ts";
import {
  normalizeStorageKey,
  type StorageObjectHead,
  StorageObjectNotFoundError,
  type StorageService,
} from "./types.ts";

// Vercel Blob storage, in a private store: nothing in it has a public URL,
// and every read goes through the app, which checks who is asking first.
//
// The SDK finds its own credentials. On Vercel that is the project's OIDC
// token together with BLOB_STORE_ID, or BLOB_READ_WRITE_TOKEN; both are set
// when a Blob store is connected to the project.

const BLOB_BUCKET_NAME = "vercel-blob";
const BLOB_ACCESS = "private";

/** The part of the Blob SDK this driver uses. Replaced by a fake in tests. */
export type BlobClient = {
  del: typeof del;
  get: typeof get;
  head: typeof head;
  put: typeof put;
};

type CreateBlobStorageServiceOptions = {
  client?: BlobClient;
  env?: EnvSource;
};

export function createBlobStorageService({
  client = { del, get, head, put },
  env = process.env,
}: CreateBlobStorageServiceOptions = {}): StorageService {
  if (!hasBlobCredentials(env)) {
    throw new ServiceConfigurationError("storage", ["BLOB_READ_WRITE_TOKEN"]);
  }

  // Reads skip the CDN cache. A signed PDF or certificate can be written
  // again under the same key, and a cached copy may lag behind by a minute.
  async function fetchObject(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    const result = await client.get(normalizedKey, {
      access: BLOB_ACCESS,
      useCache: false,
    });

    if (!result || result.statusCode !== 200) {
      throw new StorageObjectNotFoundError(normalizedKey);
    }

    return { normalizedKey, result };
  }

  async function headObject(key: string): Promise<StorageObjectHead> {
    const normalizedKey = normalizeStorageKey(key);

    try {
      const metadata = await client.head(normalizedKey);

      return {
        bucketName: BLOB_BUCKET_NAME,
        contentLength: metadata.size,
        contentType: metadata.contentType,
        etag: metadata.etag,
        exists: true,
        key: normalizedKey,
      };
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        return {
          bucketName: BLOB_BUCKET_NAME,
          exists: false,
          key: normalizedKey,
        };
      }

      throw error;
    }
  }

  return {
    async deleteObject(key) {
      await client.del(normalizeStorageKey(key));
    },
    async getObject(key) {
      const { normalizedKey, result } = await fetchObject(key);
      const body = new Uint8Array(
        await new Response(result.stream).arrayBuffer(),
      );

      return {
        body,
        bucketName: BLOB_BUCKET_NAME,
        contentLength: body.byteLength,
        contentType: result.blob.contentType,
        etag: result.blob.etag,
        key: normalizedKey,
      };
    },
    async getObjectStream(key) {
      const { normalizedKey, result } = await fetchObject(key);

      return {
        bucketName: BLOB_BUCKET_NAME,
        contentLength: result.blob.size,
        contentType: result.blob.contentType,
        key: normalizedKey,
        stream: result.stream,
      };
    },
    headObject,
    async putObject(input) {
      const normalizedKey = normalizeStorageKey(input.key);

      try {
        await client.put(
          normalizedKey,
          Buffer.from(
            input.body.buffer,
            input.body.byteOffset,
            input.body.byteLength,
          ),
          {
            access: BLOB_ACCESS,
            // Keys are complete and deterministic: the same key must always
            // name the same object. Writing it again replaces it, unless the
            // caller asked for what is there to be kept, and then Blob
            // itself refuses the write.
            addRandomSuffix: false,
            allowOverwrite: !input.keepExisting,
            contentType: input.contentType,
          },
        );
      } catch (error) {
        // The SDK has no error of its own for "something is already stored
        // here", so ask. An object that is there is what was asked for; a
        // write that failed for any other reason is still a failure.
        if (!input.keepExisting || !(await headObject(normalizedKey)).exists) {
          throw error;
        }
      }

      return {
        bucketName: BLOB_BUCKET_NAME,
        key: normalizedKey,
      };
    },
  };
}
