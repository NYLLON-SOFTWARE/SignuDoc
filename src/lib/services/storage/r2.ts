import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { getEnv, type EnvSource } from "../../utils/env.ts";
import { assertServiceConfig } from "../service-config.ts";
import {
  normalizeStorageKey,
  StorageObjectNotFoundError,
  type StorageService,
} from "./types.ts";

const STORAGE_ENV_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_BUCKET_NAME",
  "R2_SECRET_ACCESS_KEY",
] as const;

type CreateR2StorageServiceOptions = {
  env?: EnvSource;
  s3Client?: S3Client;
};

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NotFound" || error.name === "NoSuchKey")
  );
}

async function readS3Body(body: unknown): Promise<Uint8Array> {
  if (
    !body ||
    typeof body !== "object" ||
    !("transformToByteArray" in body) ||
    typeof body.transformToByteArray !== "function"
  ) {
    return new Uint8Array();
  }

  return (
    body as {
      transformToByteArray: () => Promise<Uint8Array>;
    }
  ).transformToByteArray();
}

export function createR2StorageService({
  env = process.env,
  s3Client,
}: CreateR2StorageServiceOptions = {}): StorageService {
  assertServiceConfig("storage", STORAGE_ENV_KEYS, env);

  const storageEnv = getEnv(env).storage;
  const config = {
    accessKeyId: storageEnv.accessKeyId!,
    bucketName: storageEnv.bucketName!,
    endpoint: `https://${storageEnv.accountId!}.r2.cloudflarestorage.com`,
    region: "auto" as const,
    secretAccessKey: storageEnv.secretAccessKey!,
  };
  const client =
    s3Client ??
    new S3Client({
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      endpoint: config.endpoint,
      region: config.region,
    });

  return {
    async deleteObject(key) {
      const normalizedKey = normalizeStorageKey(key);

      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucketName,
          Key: normalizedKey,
        }),
      );
    },
    async getObject(key) {
      const normalizedKey = normalizeStorageKey(key);
      const response = await client.send(
        new GetObjectCommand({
          Bucket: config.bucketName,
          Key: normalizedKey,
        }),
      );
      const body = await readS3Body(response.Body);

      return {
        body,
        bucketName: config.bucketName,
        contentLength: response.ContentLength,
        contentType: response.ContentType,
        etag: response.ETag?.replaceAll('"', ""),
        key: normalizedKey,
      };
    },
    async getObjectStream(key) {
      const normalizedKey = normalizeStorageKey(key);

      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: config.bucketName,
            Key: normalizedKey,
          }),
        );

        if (!response.Body) {
          throw new StorageObjectNotFoundError(normalizedKey);
        }

        return {
          bucketName: config.bucketName,
          contentLength: response.ContentLength,
          contentType: response.ContentType,
          key: normalizedKey,
          stream:
            response.Body.transformToWebStream() as ReadableStream<Uint8Array>,
        };
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new StorageObjectNotFoundError(normalizedKey);
        }

        throw error;
      }
    },
    async headObject(key) {
      const normalizedKey = normalizeStorageKey(key);

      try {
        const response = await client.send(
          new HeadObjectCommand({
            Bucket: config.bucketName,
            Key: normalizedKey,
          }),
        );

        return {
          bucketName: config.bucketName,
          contentLength: response.ContentLength,
          contentType: response.ContentType,
          etag: response.ETag?.replaceAll('"', ""),
          exists: true,
          key: normalizedKey,
        };
      } catch (error) {
        if (isNotFoundError(error)) {
          return {
            bucketName: config.bucketName,
            exists: false,
            key: normalizedKey,
          };
        }

        throw error;
      }
    },
    async putObject(input) {
      const key = normalizeStorageKey(input.key);

      await client.send(
        new PutObjectCommand({
          Body: input.body,
          Bucket: config.bucketName,
          ContentLength: input.body.length,
          ContentType: input.contentType,
          Key: key,
        }),
      );

      return {
        bucketName: config.bucketName,
        key,
      };
    },
  };
}
