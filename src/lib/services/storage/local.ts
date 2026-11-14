import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { type EnvSource } from "../../utils/env.ts";
import {
  normalizeStorageKey,
  StorageObjectNotFoundError,
  type StorageService,
} from "./types.ts";

// Filesystem storage for local development, the end-to-end test, and
// self-hosted installs that run on a machine with a persistent disk.
// It cannot work on Vercel, where the filesystem is read-only and ephemeral.

const LOCAL_BUCKET_NAME = "local";
const DEFAULT_LOCAL_STORAGE_DIR = ".data/storage";
const METADATA_SUFFIX = ".meta.json";

type CreateLocalStorageServiceOptions = {
  env?: EnvSource;
  rootDir?: string;
};

type LocalObjectMetadata = {
  contentType?: string;
};

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

// Writes to a temporary name and renames it into place, so a reader never
// sees a half-written file.
async function writeFileAtomically(
  filePath: string,
  data: Uint8Array | string,
) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });

    throw error;
  }
}

// Writes the file only if there is none. A hard link cannot replace a file
// that is there, and the file it makes is whole from its first moment, so of
// two writers that arrive together exactly one is kept.
async function writeFileIfAbsent(filePath: string, data: Uint8Array | string) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, data);
    await link(temporaryPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function createLocalStorageService({
  env = process.env,
  rootDir,
}: CreateLocalStorageServiceOptions = {}): StorageService {
  if (env.VERCEL === "1") {
    throw new Error(
      "STORAGE_DRIVER=local cannot be used on Vercel. Connect a Vercel Blob store instead.",
    );
  }

  // The comment stops Turbopack from tracing the whole project into the
  // server bundle because of a path it cannot analyse.
  const resolvedRootDir = path.resolve(
    /*turbopackIgnore: true*/ rootDir ??
      env.STORAGE_LOCAL_DIR?.trim() ??
      DEFAULT_LOCAL_STORAGE_DIR,
  );

  function resolveObjectPath(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    const objectPath = path.join(
      /*turbopackIgnore: true*/ resolvedRootDir,
      ...normalizedKey.split("/"),
    );

    return { normalizedKey, objectPath };
  }

  async function readMetadata(
    objectPath: string,
  ): Promise<LocalObjectMetadata> {
    try {
      return JSON.parse(
        await readFile(`${objectPath}${METADATA_SUFFIX}`, "utf8"),
      ) as LocalObjectMetadata;
    } catch {
      return {};
    }
  }

  async function statObject(objectPath: string) {
    try {
      const stats = await stat(objectPath);

      return stats.isFile() ? stats : null;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  return {
    async deleteObject(key) {
      const { objectPath } = resolveObjectPath(key);

      await Promise.all([
        rm(objectPath, { force: true }),
        rm(`${objectPath}${METADATA_SUFFIX}`, { force: true }),
      ]);
    },
    async getObject(key) {
      const { normalizedKey, objectPath } = resolveObjectPath(key);

      try {
        const [body, metadata] = await Promise.all([
          readFile(objectPath),
          readMetadata(objectPath),
        ]);

        return {
          body: new Uint8Array(body),
          bucketName: LOCAL_BUCKET_NAME,
          contentLength: body.length,
          contentType: metadata.contentType,
          key: normalizedKey,
        };
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new StorageObjectNotFoundError(normalizedKey);
        }

        throw error;
      }
    },
    async getObjectStream(key) {
      const { normalizedKey, objectPath } = resolveObjectPath(key);
      const stats = await statObject(objectPath);

      if (!stats) {
        throw new StorageObjectNotFoundError(normalizedKey);
      }

      const metadata = await readMetadata(objectPath);

      return {
        bucketName: LOCAL_BUCKET_NAME,
        contentLength: stats.size,
        contentType: metadata.contentType,
        key: normalizedKey,
        stream: Readable.toWeb(
          createReadStream(objectPath),
        ) as ReadableStream<Uint8Array>,
      };
    },
    async headObject(key) {
      const { normalizedKey, objectPath } = resolveObjectPath(key);
      const stats = await statObject(objectPath);

      if (!stats) {
        return {
          bucketName: LOCAL_BUCKET_NAME,
          exists: false,
          key: normalizedKey,
        };
      }

      const metadata = await readMetadata(objectPath);

      return {
        bucketName: LOCAL_BUCKET_NAME,
        contentLength: stats.size,
        contentType: metadata.contentType,
        exists: true,
        key: normalizedKey,
      };
    },
    async putObject(input) {
      const { normalizedKey, objectPath } = resolveObjectPath(input.key);

      const write = input.keepExisting
        ? writeFileIfAbsent
        : writeFileAtomically;

      await mkdir(path.dirname(objectPath), { recursive: true });
      // Metadata first: once the object itself is visible, its content type
      // is already there to be read.
      await write(
        `${objectPath}${METADATA_SUFFIX}`,
        JSON.stringify({
          contentType: input.contentType,
        } satisfies LocalObjectMetadata),
      );
      await write(objectPath, input.body);

      return {
        bucketName: LOCAL_BUCKET_NAME,
        key: normalizedKey,
      };
    },
  };
}
