import type { S3Client } from "@aws-sdk/client-s3";

import { type EnvSource } from "../utils/env.ts";
import { createLocalStorageService } from "./storage/local.ts";
import { createR2StorageService } from "./storage/r2.ts";
import { type StorageService } from "./storage/types.ts";

export {
  StorageObjectNotFoundError,
  type StorageObject,
  type StorageObjectHead,
  type StorageObjectRef,
  type StorageObjectStream,
  type StorageService,
} from "./storage/types.ts";

export type StorageDriver = "local" | "r2";

type CreateStorageServiceOptions = {
  env?: EnvSource;
  s3Client?: S3Client;
};

export function buildContentDisposition(
  fileName: string,
  dispositionType: "attachment" | "inline" = "attachment",
): string {
  const fallbackName = fileName.replace(/["\\\r\n]+/g, "_");
  const encodedName = encodeURIComponent(fileName).replace(/\+/g, "%20");

  return `${dispositionType}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}

export function resolveStorageDriver(
  env: EnvSource = process.env,
): StorageDriver {
  const configuredDriver = env.STORAGE_DRIVER?.trim().toLowerCase();

  if (!configuredDriver) {
    return "r2";
  }

  if (configuredDriver === "local" || configuredDriver === "r2") {
    return configuredDriver;
  }

  throw new Error(
    `Unknown STORAGE_DRIVER "${configuredDriver}". Use "local" or "r2".`,
  );
}

export function createStorageService({
  env = process.env,
  s3Client,
}: CreateStorageServiceOptions = {}): StorageService {
  switch (resolveStorageDriver(env)) {
    case "local":
      return createLocalStorageService({ env });
    case "r2":
      return createR2StorageService({ env, s3Client });
  }
}
