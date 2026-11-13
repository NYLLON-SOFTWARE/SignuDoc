import {
  type DbExecutor,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { findRecordKeeper } from "./people.ts";
import {
  buildEnvelopeThumbnailKey,
  getRecipientCertificateKey,
} from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import { readStoredSettings } from "./settings.ts";
import { type EnvSource, isHostedMode, resolveAppUrl } from "./utils/env.ts";

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
  finishedEnvelopeDeletionFailures: string[];
  finishedEnvelopesDeleted: number;
  finishedEnvelopeWarningsSent: number;
  ranAt: number;
};

/** How long before deletion a sender is told, and the shortest notice. */
export const RETENTION_WARNING_DAYS = 30;
// Nothing is deleted until this long after its warning, whatever the
// setting says by then: the date in the warning is never brought forward,
// even when an administrator shortens the period afterwards.
const RETENTION_MIN_NOTICE_DAYS = RETENTION_WARNING_DAYS;

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

function thumbnailKeyOf(
  envelope: Pick<EnvelopeArtifactRow, "id" | "sourcePdfKey" | "userId">,
): string {
  return buildEnvelopeThumbnailKey({
    envelopeId: envelope.id,
    sourcePdfKey: envelope.sourcePdfKey,
    userId: envelope.userId,
  });
}

/**
 * The sender's browser can store a first-page picture while its envelope is
 * being deleted. The upload keeps the picture when the envelope's row is
 * still there, so anything that deletes files before the row has to look
 * once more after the row has gone. An upload that finishes later than this
 * finds no row and removes its own picture.
 */
async function deleteThumbnailStoredMeanwhile(
  envelope: Pick<EnvelopeArtifactRow, "id" | "sourcePdfKey" | "userId">,
  storageService: StorageService,
) {
  await storageService.deleteObject(thumbnailKeyOf(envelope)).catch((error) => {
    console.error(
      `Failed to delete a late thumbnail for deleted envelope ${envelope.id}:`,
      error,
    );
  });
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
  // A picture of the first page is as private as the document itself.
  keys.add(thumbnailKeyOf(envelope));

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

// An expired download link is kept for a year so the signer can still use
// it to ask for a new one (see renewRecipientDownloadLinks).
const EXPIRED_DOWNLOAD_TOKEN_GRACE_SECONDS = 365 * DAY_IN_SECONDS;

async function deleteExpiredRecipientDownloadTokens(
  now: number,
  database: DbExecutor,
): Promise<number> {
  const result = await database.query(
    `
      DELETE FROM recipient_download_tokens
      WHERE expires_at <= $1
    `,
    [now - EXPIRED_DOWNLOAD_TOKEN_GRACE_SECONDS],
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

const FINISHED_ENVELOPE_STATUSES = ["completed", "declined", "voided"];
/** How many keepers in a row may lose the role before the next run takes over. */
const MAX_KEEPER_ATTEMPTS = 5;

/**
 * On a self-hosted install the organization owns its signed records, so a
 * person leaving must not take them along. Finished envelopes move to an
 * administrator before the
 * account is deleted. Only an administrator may receive them: anyone else
 * would gain documents they were never party to. Each envelope is marked
 * as handed over, so that it moves on again if its keeper stops being an
 * administrator. Returns false when there is no administrator to keep
 * them, which leaves the account for the next run.
 */
async function handOverFinishedEnvelopes(
  userId: string,
  now: number,
  database: DbExecutor,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_KEEPER_ATTEMPTS; attempt += 1) {
    const finished = await queryOne<{ count: string }>(
      database,
      `
        SELECT count(*)::text AS count
        FROM envelopes
        WHERE user_id = $1 AND status = ANY($2::text[])
      `,
      [userId, FINISHED_ENVELOPE_STATUSES],
    );

    if (Number(finished?.count ?? 0) === 0) {
      return true;
    }

    const keeperId = await findRecordKeeper(userId, database);

    if (!keeperId) {
      return false;
    }

    // The keeper was an administrator when chosen, but that role can be
    // taken away at any moment. So the move looks at the keeper again while
    // it holds their row: a removal already under way finishes first and is
    // seen here, and one that starts now waits until the records have
    // moved. Nothing moves to someone who is no longer an administrator.
    // An envelope that was handed over before keeps the day it first was.
    const moved = await database.query(
      `
        UPDATE envelopes e
        SET user_id = k.id,
            handed_over_at = COALESCE(e.handed_over_at, $4)
        FROM (
          SELECT u.id
          FROM "user" u
          WHERE u.id = $1
            AND u.role = 'admin'
            AND NOT EXISTS (
              SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
            )
          FOR SHARE OF u
        ) k
        WHERE e.user_id = $2 AND e.status = ANY($3::text[])
      `,
      [keeperId, userId, FINISHED_ENVELOPE_STATUSES, now],
    );

    if ((moved.rowCount ?? 0) > 0) {
      console.info(
        `Moved finished envelopes from closed account ${userId} to ${keeperId}.`,
      );

      return true;
    }

    // The keeper stopped being one in between. Look for another.
  }

  return false;
}

export class AccountPurgeDeferredError extends Error {
  constructor(userId: string) {
    super(
      `Account ${userId} holds finished envelopes and no other user can keep them. Its purge is deferred until another administrator exists or the records are exported and deleted by hand.`,
    );
    this.name = "AccountPurgeDeferredError";
  }
}

function isPool(database: DbExecutor): database is ReturnType<typeof getDb> {
  return "connect" in database && "totalCount" in database;
}

/**
 * Deletes the account with everything that hangs on it, and returns the
 * files those rows pointed at. Returns null when the account is already
 * gone.
 *
 * The account's row is locked before the files are listed. Saving a
 * template or uploading a document writes a row that points at the account,
 * and Postgres makes such a write wait for this lock. So a save that got in
 * first has finished and its file is in the list, and one that comes after
 * finds no account, fails, and takes its own file back. Without the lock a
 * save could land between the list and the delete: its row went with the
 * account and its file stayed, with nothing left that knew of it.
 */
async function deleteAccountRows(
  userId: string,
  database: DbExecutor,
): Promise<string[] | null> {
  const account = await queryOne<{ id: string }>(
    database,
    `SELECT id FROM "user" WHERE id = $1 FOR UPDATE`,
    [userId],
  );

  if (!account) {
    return null;
  }

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

  // Templates go with the account: their rows with the user's row below,
  // their documents here.
  const templates = await queryMany<{ sourcePdfKey: string }>(
    database,
    `SELECT source_pdf_key AS "sourcePdfKey" FROM templates WHERE user_id = $1`,
    [userId],
  );

  for (const template of templates) {
    storageKeys.add(template.sourcePdfKey);
  }

  await database.query(
    `
      DELETE FROM "user"
      WHERE id = $1
    `,
    [userId],
  );

  return [...storageKeys];
}

async function purgeQueuedAccount(
  userId: string,
  now: number,
  database: DbExecutor,
  storageService: StorageService,
  env: EnvSource = process.env,
): Promise<boolean> {
  if (
    !isHostedMode(env) &&
    !(await handOverFinishedEnvelopes(userId, now, database))
  ) {
    throw new AccountPurgeDeferredError(userId);
  }

  // One transaction, so the lock on the account holds from the list of its
  // files to the delete. A caller that hands in its own connection decides
  // where its transaction ends.
  const storageKeys = isPool(database)
    ? await withTransaction((tx) => deleteAccountRows(userId, tx), database)
    : await deleteAccountRows(userId, database);

  if (!storageKeys) {
    return false;
  }

  // Only once the rows are gone for good.
  await deleteStorageKeys(storageKeys, storageService).catch((error) => {
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

type FinishedEnvelopeRow = EnvelopeArtifactRow & {
  finishedAt: number;
  ownerEmail: string;
  ownerName: string;
  retentionWarnedAt: number | null;
  title: string;
};

/**
 * Finished envelopes there is something to do with now: not yet warned and
 * inside the warning window, or warned long enough ago and past the period.
 * Envelopes waiting out their notice are left out, so they cannot fill the
 * batch and hold back the ones behind them.
 */
async function listFinishedEnvelopesToHandle(
  {
    deleteBefore,
    warnBefore,
    warnedBefore,
  }: { deleteBefore: number; warnBefore: number; warnedBefore: number },
  database: DbExecutor,
): Promise<FinishedEnvelopeRow[]> {
  return queryMany<FinishedEnvelopeRow>(
    database,
    `
      SELECT
        e.id,
        e.user_id AS "userId",
        e.status,
        e.title,
        e.source_pdf_key AS "sourcePdfKey",
        e.signed_pdf_key AS "signedPdfKey",
        e.evidence_key AS "evidenceKey",
        e.updated_at AS "updatedAt",
        e.retention_warned_at AS "retentionWarnedAt",
        COALESCE(e.completed_at, e.declined_at, e.voided_at, e.updated_at) AS "finishedAt",
        u.email AS "ownerEmail",
        u.name AS "ownerName"
      FROM envelopes e
      JOIN "user" u ON u.id = e.user_id
      WHERE e.status IN ('completed', 'declined', 'voided')
        AND (
          (
            e.retention_warned_at IS NULL
            AND COALESCE(e.completed_at, e.declined_at, e.voided_at, e.updated_at) < $1
          )
          OR (
            e.retention_warned_at <= $3
            AND COALESCE(e.completed_at, e.declined_at, e.voided_at, e.updated_at) < $2
          )
        )
      ORDER BY "finishedAt" ASC, e.id ASC
      LIMIT 500
    `,
    [warnBefore, deleteBefore, warnedBefore],
  );
}

function formatDay(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

async function warnBeforeRetentionDeletion(
  envelope: FinishedEnvelopeRow,
  deleteOn: number,
  now: number,
  database: DbExecutor,
  emailService: EmailService,
) {
  const appUrl = resolveAppUrl();
  const link = appUrl ? `${appUrl}/envelopes/${envelope.id}` : null;

  await emailService.send(
    {
      subject: `"${envelope.title}" will be deleted on ${formatDay(deleteOn)}`,
      template: "retention_notice",
      textBody: [
        `Hello ${envelope.ownerName},`,
        "",
        `Your organization keeps finished documents for a set time. "${envelope.title}" and its audit trail will be deleted on or after ${formatDay(deleteOn)}.`,
        "",
        "Download the signed PDF and the certificate now if you need to keep them.",
        ...(link ? ["", link] : []),
      ].join("\n"),
      to: envelope.ownerEmail,
    },
    { idempotencyKey: `retention-notice/${envelope.id}` },
  );

  await database.query(
    `UPDATE envelopes SET retention_warned_at = $1 WHERE id = $2`,
    [now, envelope.id],
  );
}

/**
 * Applies the install's retention period to finished envelopes: a warning to
 * the sender first, deletion once the period has passed and the warning is
 * at least RETENTION_MIN_NOTICE_DAYS old.
 */
async function applyRetentionPeriod(
  retentionDays: number,
  now: number,
  database: DbExecutor,
  storageService: StorageService,
  emailService: () => EmailService,
  summary: RetentionSweepSummary,
) {
  const warnBefore =
    now - (retentionDays - RETENTION_WARNING_DAYS) * DAY_IN_SECONDS;
  const candidates = await listFinishedEnvelopesToHandle(
    {
      deleteBefore: now - retentionDays * DAY_IN_SECONDS,
      warnBefore,
      warnedBefore: now - RETENTION_MIN_NOTICE_DAYS * DAY_IN_SECONDS,
    },
    database,
  );
  const fieldImagesByEnvelopeId = await listFieldImagesForEnvelopeIds(
    candidates.map((envelope) => envelope.id),
    database,
  );

  for (const envelope of candidates) {
    const deleteOn = envelope.finishedAt + retentionDays * DAY_IN_SECONDS;

    try {
      if (envelope.retentionWarnedAt === null) {
        await warnBeforeRetentionDeletion(
          envelope,
          Math.max(deleteOn, now + RETENTION_MIN_NOTICE_DAYS * DAY_IN_SECONDS),
          now,
          database,
          emailService(),
        );
        summary.finishedEnvelopeWarningsSent += 1;
        continue;
      }

      if (
        deleteOn > now ||
        envelope.retentionWarnedAt >
          now - RETENTION_MIN_NOTICE_DAYS * DAY_IN_SECONDS
      ) {
        continue;
      }

      // Files first: a failure leaves the row, so the next run retries.
      await deleteStorageKeys(
        buildEnvelopeStorageKeys(
          envelope,
          fieldImagesByEnvelopeId.get(envelope.id) ?? [],
        ),
        storageService,
      );

      const deleted = await database.query(
        `DELETE FROM envelopes WHERE id = $1 AND status = $2`,
        [envelope.id, envelope.status],
      );

      if (deleted.rowCount === 1) {
        summary.finishedEnvelopesDeleted += 1;
        await deleteThumbnailStoredMeanwhile(envelope, storageService);
      }
    } catch (error) {
      summary.finishedEnvelopeDeletionFailures.push(envelope.id);
      console.error(
        `Retention period handling failed for envelope ${envelope.id}:`,
        error,
      );
    }
  }
}

/** Deletes these envelopes and their stored files. Returns how many went. */
export async function deleteEnvelopesAndFiles(
  envelopeIds: readonly string[],
  database: DbExecutor = getDb(),
  storageService: StorageService = createStorageService(),
): Promise<number> {
  if (envelopeIds.length === 0) {
    return 0;
  }

  const envelopes = await queryMany<EnvelopeArtifactRow>(
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
      WHERE id = ANY($1::text[])
    `,
    [envelopeIds],
  );
  const fieldImagesByEnvelopeId = await listFieldImagesForEnvelopeIds(
    envelopes.map((envelope) => envelope.id),
    database,
  );
  // Files first, then rows: if a file cannot be deleted, the row (and the
  // list of its files) is still there for the next attempt. Deleting a
  // file that is already gone succeeds.
  for (const envelope of envelopes) {
    await deleteStorageKeys(
      buildEnvelopeStorageKeys(
        envelope,
        fieldImagesByEnvelopeId.get(envelope.id) ?? [],
      ),
      storageService,
    );
  }

  const deleted = await database.query(
    `DELETE FROM envelopes WHERE id = ANY($1::text[])`,
    [envelopes.map((envelope) => envelope.id)],
  );

  for (const envelope of envelopes) {
    await deleteThumbnailStoredMeanwhile(envelope, storageService);
  }

  return deleted.rowCount ?? 0;
}

export async function runRetentionSweep({
  database = getDb(),
  emailService,
  now = getCurrentUnixTimestamp(),
  storageService = createStorageService(),
}: {
  database?: DbExecutor;
  emailService?: EmailService;
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
    finishedEnvelopeDeletionFailures: [],
    finishedEnvelopesDeleted: 0,
    finishedEnvelopeWarningsSent: 0,
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
        now,
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

  const retentionDays = (await readStoredSettings(database))?.retentionDays;

  if (retentionDays) {
    let service = emailService;

    await applyRetentionPeriod(
      retentionDays,
      now,
      database,
      storageService,
      () => (service ??= createEmailService()),
      summary,
    );
  }

  return summary;
}
