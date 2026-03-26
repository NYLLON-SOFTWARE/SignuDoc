import {
  type DbExecutor,
  getDb,
  queryMany,
  queryOne,
} from "./db/connection.ts";
import { getRecipientCertificateKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";

const DAY_IN_SECONDS = 24 * 60 * 60;
export const STALE_DRAFT_RETENTION_DAYS = 30;
export const ACCOUNT_CLOSURE_EXPORT_WINDOW_DAYS = 30;

type AccountClosureRequestRow = {
  exportExpiresAt: number;
  purgeAfterAt: number;
  requestedAt: number;
  updatedAt: number;
  userId: string;
};

type EnvelopeArtifactRow = {
  evidenceKey: string | null;
  id: string;
  signedPdfKey: string | null;
  sourcePdfKey: string;
  status: "completed" | "declined" | "draft" | "sent" | "voided";
  updatedAt: number;
  userId: string;
};

type FieldImageRow = {
  envelopeId: string;
  imageKey: string;
};

export type ScheduledAccountClosure = {
  alreadyQueued: boolean;
  exportExpiresAt: number;
  purgeAfterAt: number;
  requestedAt: number;
  userId: string;
};

export type RetentionSweepSummary = {
  accountPurgeFailures: string[];
  accountsPurged: number;
  draftDeletionFailures: string[];
  draftsDeleted: number;
  expiredRecipientDownloadTokensDeleted: number;
  ranAt: number;
};

function getCurrentUnixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

async function getAccountClosureRequestRow(
  userId: string,
  database: DbExecutor,
): Promise<AccountClosureRequestRow | null> {
  return queryOne<AccountClosureRequestRow>(
    database,
    `
      SELECT
        user_id AS "userId",
        requested_at AS "requestedAt",
        export_expires_at AS "exportExpiresAt",
        purge_after_at AS "purgeAfterAt",
        updated_at AS "updatedAt"
      FROM account_closure_requests
      WHERE user_id = $1
    `,
    [userId],
  );
}

async function listDueAccountClosureRequests(
  now: number,
  database: DbExecutor,
): Promise<AccountClosureRequestRow[]> {
  return queryMany<AccountClosureRequestRow>(
    database,
    `
      SELECT
        user_id AS "userId",
        requested_at AS "requestedAt",
        export_expires_at AS "exportExpiresAt",
        purge_after_at AS "purgeAfterAt",
        updated_at AS "updatedAt"
      FROM account_closure_requests
      WHERE purge_after_at <= $1
      ORDER BY purge_after_at ASC, requested_at ASC
    `,
    [now],
  );
}

async function listStaleDraftEnvelopes(
  staleBefore: number,
  database: DbExecutor,
): Promise<EnvelopeArtifactRow[]> {
  return queryMany<EnvelopeArtifactRow>(
    database,
    `
      SELECT
        id,
        user_id AS "userId",
        status,
        source_pdf_key AS "sourcePdfKey",
        signed_pdf_key AS "signedPdfKey",
        evidence_key AS "evidenceKey",
        updated_at AS "updatedAt"
      FROM envelopes
      WHERE status = 'draft'
        AND updated_at < $1
      ORDER BY updated_at ASC, id ASC
    `,
    [staleBefore],
  );
}

async function listEnvelopeArtifactsForUser(
  userId: string,
  database: DbExecutor,
): Promise<EnvelopeArtifactRow[]> {
  return queryMany<EnvelopeArtifactRow>(
    database,
    `
      SELECT
        id,
        user_id AS "userId",
        status,
        source_pdf_key AS "sourcePdfKey",
        signed_pdf_key AS "signedPdfKey",
        evidence_key AS "evidenceKey",
        updated_at AS "updatedAt"
      FROM envelopes
      WHERE user_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [userId],
  );
}

async function listFieldImagesForEnvelopeIds(
  envelopeIds: readonly string[],
  database: DbExecutor,
): Promise<Map<string, string[]>> {
  if (envelopeIds.length === 0) {
    return new Map();
  }

  const placeholders = envelopeIds
    .map((_, index) => `$${String(index + 1)}`)
    .join(", ");
  const rows = await queryMany<FieldImageRow>(
    database,
    `
      SELECT
        envelope_id AS "envelopeId",
        image_key AS "imageKey"
      FROM fields
      WHERE envelope_id IN (${placeholders})
        AND image_key IS NOT NULL
    `,
    envelopeIds,
  );

  const keysByEnvelopeId = new Map<string, string[]>();

  for (const row of rows) {
    const currentKeys = keysByEnvelopeId.get(row.envelopeId) ?? [];
    currentKeys.push(row.imageKey);
    keysByEnvelopeId.set(row.envelopeId, currentKeys);
  }

  return keysByEnvelopeId;
}

function buildEnvelopeStorageKeys(
  envelope: Pick<
    EnvelopeArtifactRow,
    "evidenceKey" | "id" | "signedPdfKey" | "sourcePdfKey" | "status" | "userId"
  >,
  fieldImageKeys: readonly string[],
): string[] {
  const keys = new Set<string>(fieldImageKeys);

  keys.add(envelope.sourcePdfKey);

  if (envelope.signedPdfKey) {
    keys.add(envelope.signedPdfKey);
  }

  if (envelope.evidenceKey) {
    keys.add(envelope.evidenceKey);
    keys.add(getRecipientCertificateKey(envelope.evidenceKey));
  }

  return [...keys];
}

async function deleteStorageKeys(
  keys: readonly string[],
  storageService: StorageService,
) {
  for (const key of keys) {
    await storageService.deleteObject(key);
  }
}

async function deleteExpiredRecipientDownloadTokens(
  now: number,
  database: DbExecutor,
): Promise<number> {
  const result = await database.query(
    `
      DELETE FROM recipient_download_tokens
      WHERE expires_at <= $1
    `,
    [now],
  );

  return result.rowCount ?? 0;
}

function getClosureSchedule(requestedAt = getCurrentUnixTimestamp()) {
  const exportExpiresAt =
    requestedAt + ACCOUNT_CLOSURE_EXPORT_WINDOW_DAYS * DAY_IN_SECONDS;

  return {
    exportExpiresAt,
    purgeAfterAt: exportExpiresAt,
    requestedAt,
    updatedAt: requestedAt,
  };
}

export async function scheduleAccountClosure(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<ScheduledAccountClosure> {
  const existingRequest = await getAccountClosureRequestRow(userId, database);

  if (existingRequest) {
    return {
      alreadyQueued: true,
      exportExpiresAt: existingRequest.exportExpiresAt,
      purgeAfterAt: existingRequest.purgeAfterAt,
      requestedAt: existingRequest.requestedAt,
      userId,
    };
  }

  const schedule = getClosureSchedule();

  await database.query(
    `
      INSERT INTO account_closure_requests (
        user_id,
        requested_at,
        export_expires_at,
        purge_after_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5)
    `,
    [
      userId,
      schedule.requestedAt,
      schedule.exportExpiresAt,
      schedule.purgeAfterAt,
      schedule.updatedAt,
    ],
  );

  return {
    alreadyQueued: false,
    exportExpiresAt: schedule.exportExpiresAt,
    purgeAfterAt: schedule.purgeAfterAt,
    requestedAt: schedule.requestedAt,
    userId,
  };
}

async function purgeQueuedAccount(
  userId: string,
  database: DbExecutor,
  storageService: StorageService,
): Promise<boolean> {
  const envelopes = await listEnvelopeArtifactsForUser(userId, database);
  const fieldImagesByEnvelopeId = await listFieldImagesForEnvelopeIds(
    envelopes.map((envelope) => envelope.id),
    database,
  );
  const storageKeys = new Set<string>();

  for (const envelope of envelopes) {
    for (const key of buildEnvelopeStorageKeys(
      envelope,
      fieldImagesByEnvelopeId.get(envelope.id) ?? [],
    )) {
      storageKeys.add(key);
    }
  }

  const deleteResult = await database.query(
    `
      DELETE FROM "user"
      WHERE id = $1
    `,
    [userId],
  );

  if (deleteResult.rowCount !== 1) {
    return false;
  }

  await deleteStorageKeys([...storageKeys], storageService).catch((error) => {
    console.error(
      `Failed to delete storage artifacts for purged account ${userId}:`,
      error,
    );
  });

  return true;
}

async function purgeStaleDraftEnvelope(
  envelope: EnvelopeArtifactRow,
  database: DbExecutor,
  storageService: StorageService,
  fieldImagesByEnvelopeId: ReadonlyMap<string, readonly string[]>,
): Promise<boolean> {
  const deleteResult = await database.query(
    `
      DELETE FROM envelopes
      WHERE id = $1
        AND user_id = $2
        AND status = 'draft'
        AND updated_at = $3
    `,
    [envelope.id, envelope.userId, envelope.updatedAt],
  );

  if (deleteResult.rowCount !== 1) {
    return false;
  }

  await deleteStorageKeys(
    buildEnvelopeStorageKeys(
      envelope,
      fieldImagesByEnvelopeId.get(envelope.id) ?? [],
    ),
    storageService,
  );

  return true;
}

export async function runRetentionSweep({
  database = getDb(),
  now = getCurrentUnixTimestamp(),
  storageService = createStorageService(),
}: {
  database?: DbExecutor;
  now?: number;
  storageService?: StorageService;
} = {}): Promise<RetentionSweepSummary> {
  const staleBefore = now - STALE_DRAFT_RETENTION_DAYS * DAY_IN_SECONDS;
  const staleDrafts = await listStaleDraftEnvelopes(staleBefore, database);
  const staleDraftFieldImagesByEnvelopeId = await listFieldImagesForEnvelopeIds(
    staleDrafts.map((envelope) => envelope.id),
    database,
  );
  const dueAccountClosures = await listDueAccountClosureRequests(now, database);
  const summary: RetentionSweepSummary = {
    accountPurgeFailures: [],
    accountsPurged: 0,
    draftDeletionFailures: [],
    draftsDeleted: 0,
    expiredRecipientDownloadTokensDeleted: 0,
    ranAt: now,
  };

  summary.expiredRecipientDownloadTokensDeleted =
    await deleteExpiredRecipientDownloadTokens(now, database);

  for (const envelope of staleDrafts) {
    try {
      const deleted = await purgeStaleDraftEnvelope(
        envelope,
        database,
        storageService,
        staleDraftFieldImagesByEnvelopeId,
      );

      if (deleted) {
        summary.draftsDeleted += 1;
      }
    } catch (error) {
      summary.draftDeletionFailures.push(envelope.id);
      console.error(
        `Retention cleanup failed for draft envelope ${envelope.id}:`,
        error,
      );
    }
  }

  for (const closureRequest of dueAccountClosures) {
    try {
      const deleted = await purgeQueuedAccount(
        closureRequest.userId,
        database,
        storageService,
      );

      if (deleted) {
        summary.accountsPurged += 1;
      }
    } catch (error) {
      summary.accountPurgeFailures.push(closureRequest.userId);
      console.error(
        `Retention cleanup failed for account ${closureRequest.userId}:`,
        error,
      );
    }
  }

  return summary;
}
