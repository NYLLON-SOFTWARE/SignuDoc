import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { getEnv, type EnvSource } from "../utils/env.ts";
import { assertServiceConfig } from "./service-config.ts";

const STORAGE_ENV_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_BUCKET_NAME",
  "R2_SECRET_ACCESS_KEY",
] as const;

type CreateStorageServiceOptions = {
  env?: EnvSource;
  s3Client?: S3Client;
};

export type StorageObjectRef = {
  bucketName: string;
  key: string;
};

export type PresignedStorageUrl = StorageObjectRef & {
  expiresAt: number;
  method: "GET" | "PUT";
  url: string;
};

export type StorageObject = StorageObjectRef & {
  body: Uint8Array;
  contentLength?: number;
  contentType?: string;
  etag?: string;
};

export type StorageObjectHead = StorageObjectRef & {
  contentLength?: number;
  contentType?: string;
  etag?: string;
  exists: boolean;
};

export function buildContentDisposition(
  fileName: string,
  dispositionType: "attachment" | "inline" = "attachment",
): string {
  const fallbackName = fileName.replace(/["\\\r\n]+/g, "_");
  const encodedName = encodeURIComponent(fileName).replace(/\+/g, "%20");

  return `${dispositionType}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
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

function normalizeStorageKey(key: string): string {
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

export interface StorageService {
  createPresignedDownloadUrl(input: {
    expiresInSeconds: number;
    fileName?: string;
    key: string;
  }): Promise<PresignedStorageUrl>;
  deleteObject(key: string): Promise<void>;
  getObject(key: string): Promise<StorageObject>;
  headObject(key: string): Promise<StorageObjectHead>;
  putObject(input: {
    body: Uint8Array;
    contentType: string;
    key: string;
  }): Promise<StorageObjectRef>;
}

export function createStorageService({
  env = process.env,
  s3Client,
}: CreateStorageServiceOptions = {}): StorageService {
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
    async createPresignedDownloadUrl(input) {
      const key = normalizeStorageKey(input.key);
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucketName,
          Key: key,
          ResponseContentDisposition: input.fileName
            ? buildContentDisposition(input.fileName)
            : undefined,
        }),
        {
          expiresIn: input.expiresInSeconds,
        },
      );

      return {
        bucketName: config.bucketName,
        expiresAt: Math.floor(Date.now() / 1000) + input.expiresInSeconds,
        key,
        method: "GET",
        url,
      };
    },
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
        if (
          error instanceof Error &&
          "name" in error &&
          (error.name === "NotFound" || error.name === "NoSuchKey")
        ) {
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
