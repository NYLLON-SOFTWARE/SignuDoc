import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

import { readEnv, type EnvSource } from "../../utils/env.ts";
import { requireConfigValue } from "../service-config.ts";
import {
  normalizeStorageKey,
  StorageObjectNotFoundError,
  type StorageService,
} from "./types.ts";

const SDK_MAX_ATTEMPTS = 3;
const CONDITIONAL_PUT_MAX_ATTEMPTS = 3;

type S3ClientSettings = {
  region: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
};

let sharedClient: { settingsKey: string; client: S3Client } | undefined;

function getS3Client(settings: S3ClientSettings, useSharedClient: boolean) {
  const settingsKey = useSharedClient ? JSON.stringify(settings) : undefined;
  if (settingsKey !== undefined && sharedClient?.settingsKey === settingsKey) {
    return sharedClient.client;
  }

  // The SDK resolves and refreshes credentials through its default chain.
  const client = new S3Client({
    ...settings,
    maxAttempts: SDK_MAX_ATTEMPTS,
    retryMode: "standard",
  });

  if (settingsKey !== undefined) {
    // Earlier services can still have streams in flight on the old client.
    sharedClient = { settingsKey, client };
  }

  return client;
}

function readEndpoint(env: EnvSource): string | undefined {
  const endpoint = readEnv(env, "S3_ENDPOINT");
  if (endpoint === undefined) return undefined;

  const url = URL.parse(endpoint);
  if (
    !url ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "S3_ENDPOINT must be an absolute HTTP or HTTPS URL without credentials, a query, or a fragment.",
    );
  }

  return url.href;
}

function readForcePathStyle(env: EnvSource): boolean {
  const value = env.S3_FORCE_PATH_STYLE;
  if (value !== undefined && value !== "true" && value !== "false") {
    throw new Error('S3_FORCE_PATH_STYLE must be "true" or "false".');
  }

  return value === "true";
}

function isMissingKey(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    error.$metadata.httpStatusCode === 404 &&
    error.name === "NoSuchKey"
  );
}

export function createS3StorageService({
  env = process.env,
}: { env?: EnvSource } = {}): StorageService {
  const bucketName = requireConfigValue(
    "storage",
    "S3_BUCKET",
    readEnv(env, "S3_BUCKET"),
  );
  const region = requireConfigValue(
    "storage",
    "S3_REGION",
    readEnv(env, "S3_REGION"),
  );
  const client = getS3Client(
    {
      region,
      endpoint: readEndpoint(env),
      forcePathStyle: readForcePathStyle(env),
    },
    env === process.env,
  );

  async function fetchObject(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    try {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: normalizedKey }),
      );
      if (!result.Body) {
        throw new Error("S3 returned an object without a body.");
      }

      return { normalizedKey, result, body: result.Body };
    } catch (error) {
      if (isMissingKey(error)) {
        throw new StorageObjectNotFoundError(normalizedKey);
      }
      throw error;
    }
  }

  return {
    async deleteObject(key) {
      const normalizedKey = normalizeStorageKey(key);
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucketName, Key: normalizedKey }),
        );
      } catch (error) {
        if (!isMissingKey(error)) throw error;
      }
    },
    async getObject(key) {
      const { normalizedKey, result, body } = await fetchObject(key);
      const bytes = await body.transformToByteArray();

      return {
        body: bytes,
        bucketName,
        contentLength: result.ContentLength ?? bytes.byteLength,
        contentType: result.ContentType,
        etag: result.ETag,
        key: normalizedKey,
      };
    },
    async getObjectStream(key) {
      const { normalizedKey, result, body } = await fetchObject(key);

      return {
        bucketName,
        contentLength: result.ContentLength,
        contentType: result.ContentType,
        key: normalizedKey,
        stream: body.transformToWebStream(),
      };
    },
    async headObject(key) {
      const normalizedKey = normalizeStorageKey(key);
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucketName, Key: normalizedKey }),
        );

        return {
          bucketName,
          contentLength: result.ContentLength,
          contentType: result.ContentType,
          etag: result.ETag,
          exists: true,
          key: normalizedKey,
        };
      } catch (error) {
        if (!isMissingKey(error)) {
          if (
            !(error instanceof S3ServiceException) ||
            error.$metadata.httpStatusCode !== 404 ||
            error.name !== "NotFound"
          ) {
            throw error;
          }

          // HEAD has no error body. The SDK's NotFound can mean the key or
          // the bucket is missing. Confirm access to the bucket first.
          await client.send(new HeadBucketCommand({ Bucket: bucketName }));
        }

        return { bucketName, exists: false, key: normalizedKey };
      }
    },
    async putObject(input) {
      const normalizedKey = normalizeStorageKey(input.key);
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: normalizedKey,
        Body: input.body,
        ContentType: input.contentType,
        IfNoneMatch: input.keepExisting ? "*" : undefined,
      });

      for (let attempt = 1; ; attempt++) {
        try {
          await client.send(command);
          break;
        } catch (error) {
          if (!input.keepExisting || !(error instanceof S3ServiceException)) {
            throw error;
          }

          const status = error.$metadata.httpStatusCode;
          if (status === 412) break;
          // Repeat the same conditional PUT if a concurrent operation raced
          // with S3's precondition check.
          if (status !== 409 || attempt >= CONDITIONAL_PUT_MAX_ATTEMPTS) {
            throw error;
          }
        }
      }

      return { bucketName, key: normalizedKey };
    },
  };
}
