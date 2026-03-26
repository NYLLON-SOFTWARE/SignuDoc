const DRAFT_PDF_CACHE_DB_NAME = "signudoc-draft-preview-cache";
const DRAFT_PDF_CACHE_DB_VERSION = 1;
const DRAFT_PDF_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DRAFT_PDF_CACHE_STORE_NAME = "draftPdfs";

type DraftPdfCacheRecord = {
  blob: Blob;
  createdAt: number;
  envelopeId: string;
};

let draftPdfCacheDbPromise: Promise<IDBDatabase | null> | null = null;

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

async function openDraftPdfCacheDatabase(): Promise<IDBDatabase | null> {
  if (!supportsIndexedDb()) {
    return null;
  }

  draftPdfCacheDbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(
      DRAFT_PDF_CACHE_DB_NAME,
      DRAFT_PDF_CACHE_DB_VERSION,
    );

    request.onerror = () => {
      reject(
        request.error ?? new Error("Unable to open the draft PDF cache."),
      );
    };

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(DRAFT_PDF_CACHE_STORE_NAME)) {
        database.createObjectStore(DRAFT_PDF_CACHE_STORE_NAME, {
          keyPath: "envelopeId",
        });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });

  return draftPdfCacheDbPromise;
}

function runDraftPdfCacheTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DRAFT_PDF_CACHE_STORE_NAME, mode);
    const store = transaction.objectStore(DRAFT_PDF_CACHE_STORE_NAME);
    const request = callback(store);
    let result: T;

    request.onerror = () => {
      reject(
        request.error ?? new Error("Unable to complete the draft PDF cache request."),
      );
    };

    request.onsuccess = () => {
      result = request.result;
    };

    transaction.onerror = () => {
      reject(
        transaction.error ??
          new Error("Unable to complete the draft PDF cache transaction."),
      );
    };

    transaction.oncomplete = () => {
      resolve(result);
    };
  });
}

export async function cacheDraftPdfBlob(
  envelopeId: string,
  blob: Blob,
): Promise<void> {
  const database = await openDraftPdfCacheDatabase();

  if (!database) {
    return;
  }

  await runDraftPdfCacheTransaction(database, "readwrite", (store) =>
    store.put({
      blob,
      createdAt: Date.now(),
      envelopeId,
    } satisfies DraftPdfCacheRecord),
  );
}

export async function getCachedDraftPdfBlob(
  envelopeId: string,
): Promise<Blob | null> {
  const database = await openDraftPdfCacheDatabase();

  if (!database) {
    return null;
  }

  const record = await runDraftPdfCacheTransaction<
    DraftPdfCacheRecord | undefined
  >(database, "readonly", (store) => store.get(envelopeId));

  if (!record) {
    return null;
  }

  if (Date.now() - record.createdAt > DRAFT_PDF_CACHE_MAX_AGE_MS) {
    await deleteCachedDraftPdfBlob(envelopeId);
    return null;
  }

  return record.blob;
}

async function deleteCachedDraftPdfBlob(
  envelopeId: string,
): Promise<void> {
  const database = await openDraftPdfCacheDatabase();

  if (!database) {
    return;
  }

  await runDraftPdfCacheTransaction(database, "readwrite", (store) =>
    store.delete(envelopeId),
  );
}
