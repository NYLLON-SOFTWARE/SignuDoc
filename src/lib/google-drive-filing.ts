import { createHash } from "node:crypto";
import { addAbortListener } from "node:events";

import {
  type DbPool,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { sanitizeFileNameSegment } from "./downloads.ts";
import {
  createGoogleDriveClient,
  GoogleDriveClientError,
} from "./services/google-drive.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { type EnvSource, readEnv } from "./utils/env.ts";

const BATCH_SIZE = 20;
const TIME_BUDGET_MS = 25_000;
const COMPLETION_TIME_BUDGET_MS = 8_000;

type FilingConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId: string;
  ownerEmail: string;
  startAt: number;
};

export type DriveFilingSummary = {
  filed: number;
  failures: number;
  stoppedEarly: boolean;
};

type FilingRow = {
  folderId: string;
  signedFileId: string;
  certificateFileId: string;
  signedFiled: boolean;
  certificateFiled: boolean;
};

const filingColumns = `folder_id AS "folderId", signed_file_id AS "signedFileId",
  certificate_file_id AS "certificateFileId", signed_filed AS "signedFiled",
  certificate_filed AS "certificateFiled"`;

const eligibleEnvelope = `
  e.status = 'completed' AND e.completed_at >= $1
  AND lower(u.email) = $2 AND u."emailVerified"
  AND NOT EXISTS (SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id)
`;

function readConfig(env: EnvSource): FilingConfig | null {
  const folderId = readEnv(env, "SIGNUDOC_DRIVE_FOLDER_ID");
  if (!folderId) return null;

  const ownerEmail = readEnv(env, "SIGNUDOC_DRIVE_OWNER_EMAIL")?.toLowerCase();
  const rawStart = readEnv(env, "SIGNUDOC_DRIVE_START_AT");
  const start =
    rawStart && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(rawStart)
      ? Date.parse(rawStart)
      : Number.NaN;
  const clientId = readEnv(env, "SIGNUDOC_DRIVE_CLIENT_ID");
  const clientSecret = readEnv(env, "SIGNUDOC_DRIVE_CLIENT_SECRET");
  const refreshToken = readEnv(env, "SIGNUDOC_DRIVE_REFRESH_TOKEN");
  if (
    !/^[\w-]{10,}$/.test(folderId) ||
    !ownerEmail ||
    !/^[^\s@]+@[^\s@]+$/.test(ownerEmail) ||
    !Number.isFinite(start) ||
    new Date(start).toISOString() !== rawStart?.replace(/Z$/, ".000Z") ||
    !clientId ||
    !clientSecret ||
    !refreshToken
  ) {
    throw new Error(
      "Configure the Drive folder, verified owner email, UTC start time and OAuth credentials.",
    );
  }
  return {
    clientId,
    clientSecret,
    refreshToken,
    folderId,
    ownerEmail,
    startAt: start / 1000,
  };
}

type ArtifactSource = {
  filed: boolean;
  key: string | null;
  sha256: string | null;
  title: string;
};

async function readArtifact(
  storage: StorageService,
  key: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const opening = storage.getObjectStream(key);
  const aborted = Promise.withResolvers<never>();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortListener = addAbortListener(signal, () => {
    aborted.reject(signal.reason);
    // Storage drivers may still be opening the object. Cancel the stream if
    // it eventually arrives, without holding up this run.
    const cancellation = reader
      ? reader.cancel(signal.reason)
      : opening.then(({ stream }) => stream.cancel(signal.reason));
    void cancellation.catch(() => undefined);
  });

  try {
    const { stream } = await Promise.race([opening, aborted.promise]);
    signal.throwIfAborted();
    reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    // Canceling the reader releases its pending read even when the provider
    // has yet to finish delivering the body.
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return Buffer.concat(chunks);
      chunks.push(value);
    }
  } finally {
    abortListener[Symbol.dispose]();
    reader?.releaseLock();
  }
}

/** Files a just-completed envelope or sweeps pending work for the daily job. */
export async function runGoogleDriveFiling({
  database,
  envelopeId,
  env = process.env,
  storageService,
  clientFactory = createGoogleDriveClient,
  signal: suppliedSignal,
}: {
  database: DbPool;
  envelopeId?: string;
  env?: EnvSource;
  storageService?: StorageService;
  clientFactory?: typeof createGoogleDriveClient;
  signal?: AbortSignal;
}): Promise<DriveFilingSummary | undefined> {
  const config = readConfig(env);
  if (!config) return undefined;

  const summary: DriveFilingSummary = {
    filed: 0,
    failures: 0,
    stoppedEarly: false,
  };
  const eligibility = [config.startAt, config.ownerEmail];
  const targeted = envelopeId !== undefined;
  const candidates = await queryMany<{ id: string; ownerId: string }>(
    database,
    `
    SELECT e.id, e.user_id AS "ownerId" FROM envelopes e
    JOIN "user" u ON e.user_id = u.id
    LEFT JOIN google_drive_filings f ON f.envelope_id = e.id
    WHERE ${eligibleEnvelope}
      ${targeted ? "AND e.id = $3" : ""}
      AND NOT (COALESCE(f.signed_filed, false) AND COALESCE(f.certificate_filed, false))
    ORDER BY f.last_attempt_at ASC NULLS FIRST, e.completed_at, e.id
    LIMIT ${BATCH_SIZE + 1}
  `,
    targeted ? [...eligibility, envelopeId] : eligibility,
  );
  if (!candidates.length) return summary;

  const client = clientFactory(config);
  const signal = suppliedSignal ?? AbortSignal.timeout(TIME_BUDGET_MS);
  signal.throwIfAborted();
  await client.verifyFolder(signal);
  const storage = storageService ?? createStorageService({ env });

  for (const { id, ownerId } of candidates.slice(0, BATCH_SIZE)) {
    if (signal.aborted) {
      summary.stoppedEarly = true;
      break;
    }

    try {
      let filing = await queryOne<FilingRow>(
        database,
        `
        SELECT ${filingColumns} FROM google_drive_filings WHERE envelope_id = $1
      `,
        [id],
      );
      const attemptedAt = Math.floor(Date.now() / 1000);
      if (!filing) {
        const [signedId, certificateId] = await client.generateFileIds(
          2,
          signal,
        );
        signal.throwIfAborted();
        // Commit the IDs before contacting the upload API. A retry keeps the
        // same file IDs even if the result of a previous upload was lost.
        filing = await queryOne<FilingRow>(
          database,
          `
          INSERT INTO google_drive_filings
            (envelope_id, folder_id, signed_file_id, certificate_file_id, last_attempt_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (envelope_id) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at
          RETURNING ${filingColumns}
        `,
          [id, config.folderId, signedId, certificateId, attemptedAt],
        );
      } else {
        await database.query(
          `UPDATE google_drive_filings SET last_attempt_at = $2 WHERE envelope_id = $1`,
          [id, attemptedAt],
        );
      }
      if (!filing || filing.folderId !== config.folderId) {
        throw new Error(
          "The filing destination differs from the reserved folder.",
        );
      }

      for (const artifact of ["signed", "certificate"] as const) {
        const signed = artifact === "signed";
        if (signed ? filing.signedFiled : filing.certificateFiled) continue;
        const fileId = signed ? filing.signedFileId : filing.certificateFileId;
        const filedColumn = signed ? "signed_filed" : "certificate_filed";
        const sourceParams = [...eligibility, id, ownerId];
        const sourceQuery = `
          SELECT e.title, ${signed ? "e.signed_pdf_key" : "e.evidence_key"} AS key,
            ${signed ? "e.signed_pdf_sha256" : "e.evidence_sha256"} AS sha256,
            f.${filedColumn} AS filed
          FROM envelopes e JOIN "user" u ON e.user_id = u.id
          JOIN google_drive_filings f ON f.envelope_id = e.id
          WHERE ${eligibleEnvelope} AND e.id = $3 AND e.user_id = $4
        `;
        const source = await queryOne<ArtifactSource>(
          database,
          sourceQuery,
          sourceParams,
        );
        if (source?.filed) continue;
        if (!source?.key || !source.sha256) {
          throw new Error(
            "The completed envelope or its verified artifact is unavailable.",
          );
        }
        const body = await readArtifact(storage, source.key, signal);
        if (createHash("sha256").update(body).digest("hex") !== source.sha256) {
          throw new Error("The stored artifact checksum did not match.");
        }
        signal.throwIfAborted();

        await withTransaction(async (tx) => {
          signal.throwIfAborted();
          if (targeted) await tx.query("SET LOCAL lock_timeout = '2s'");
          // Match the deletion lock order. The account lock also blocks a new
          // closure request's foreign-key check while these bytes are in flight.
          const owner = await queryOne<{ id: string }>(
            tx,
            `
            SELECT id FROM "user" WHERE id = $1 AND lower(email) = $2 AND "emailVerified"
            FOR UPDATE
          `,
            [ownerId, config.ownerEmail],
          );
          if (!owner)
            throw new Error(
              "The configured signer account is no longer eligible.",
            );

          const current = await queryOne<ArtifactSource>(
            tx,
            `${sourceQuery} FOR SHARE OF e`,
            sourceParams,
          );
          // The daily job and completion can both reach this envelope. The
          // owner lock serializes uploads, so use the journal as it is now.
          if (current?.filed) return;
          if (
            !current ||
            current.key !== source.key ||
            current.sha256 !== source.sha256
          ) {
            throw new Error(
              "The completed envelope or its artifact changed during the read.",
            );
          }
          signal.throwIfAborted();
          const name =
            sanitizeFileNameSegment(current.title) || `envelope-${id}`;
          await client.uploadPdf(
            {
              artifact,
              envelopeId: id,
              fileId,
              name: `${name} - ${artifact}.pdf`,
              bytes: body,
            },
            signal,
          );
          await tx.query(
            `UPDATE google_drive_filings SET ${filedColumn} = true WHERE envelope_id = $1`,
            [id],
          );
        }, database);
      }
      summary.filed += 1;
    } catch (error) {
      // Provider and storage errors may contain sensitive context.
      console.error(
        `${targeted ? "[signing]" : "[retention]"} Google Drive could not file a completed envelope:`,
        id,
        error instanceof GoogleDriveClientError
          ? error.message
          : error instanceof Error
            ? error.name
            : "unknown",
      );
      summary.failures += 1;
      summary.stoppedEarly ||= signal.aborted;
    }
  }
  summary.stoppedEarly ||= candidates.length > BATCH_SIZE;
  return summary;
}

export async function fileCompletedEnvelopeInDrive({
  database,
  envelopeId,
  storageService,
}: {
  database: DbPool;
  envelopeId: string;
  storageService: StorageService;
}): Promise<void> {
  if (!readEnv(process.env, "SIGNUDOC_DRIVE_FOLDER_ID")) return;

  // Cloud Run can suspend CPU when the signing response ends. Allow a short
  // attempt during the request, then leave unfinished work to the daily job.
  const signal = AbortSignal.timeout(COMPLETION_TIME_BUDGET_MS);

  try {
    await runGoogleDriveFiling({
      database,
      envelopeId,
      signal,
      storageService,
    });
  } catch (error) {
    console.error(
      "[signing] Google Drive filing did not finish:",
      envelopeId,
      error instanceof GoogleDriveClientError
        ? error.message
        : error instanceof Error
          ? error.name
          : "unknown",
    );
  }
}
