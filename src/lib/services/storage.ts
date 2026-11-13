import { type EnvSource } from "../utils/env.ts";
import { createBlobStorageService } from "./storage/blob.ts";
import { resolveStorageDriver } from "./storage/driver.ts";
import { createLocalStorageService } from "./storage/local.ts";
import { type StorageService } from "./storage/types.ts";

export {
  StorageObjectNotFoundError,
  type StorageObject,
  type StorageObjectHead,
  type StorageObjectRef,
  type StorageObjectStream,
  type StorageService,
} from "./storage/types.ts";

export {
  hasBlobCredentials,
  resolveStorageDriver,
  supportsDirectUploads,
  type StorageDriver,
} from "./storage/driver.ts";

type CreateStorageServiceOptions = {
  env?: EnvSource;
};

export function buildContentDisposition(
  fileName: string,
  dispositionType: "attachment" | "inline" = "attachment",
): string {
  // Header values must be Latin-1, and the quoted fallback is safest as plain
  // ASCII. Browsers that understand filename* (all current ones) use the
  // UTF-8 name instead.
  const fallbackName = fileName.replace(/[^\x20-\x7e]+|["\\]+/g, "_");
  const encodedName = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${dispositionType}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}

export function createStorageService({
  env = process.env,
}: CreateStorageServiceOptions = {}): StorageService {
  switch (resolveStorageDriver(env)) {
    case "blob":
      return createBlobStorageService({ env });
    case "local":
      return createLocalStorageService({ env });
  }
}
