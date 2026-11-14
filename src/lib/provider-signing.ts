import { createHash, randomBytes } from "node:crypto";

import { getDb, queryOne, type DbPool } from "./db/connection.ts";
import { findSignatures, fillSignature } from "./services/pdf-incremental.ts";
import {
  prepareRevisionZero,
  prepareSignerRevision,
} from "./services/pdf-revision.ts";
import { requestDocumentTimestamp, sha256Hex } from "./services/pdf-seal.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "./services/seal-identity.ts";
import {
  addSignatureTimestamp,
  checkSignerSignature,
  SignerSignatureError,
  type SignatureLevel,
} from "./services/signer-cms.ts";
import {
  signingProviderById,
  SigningProviderError,
  type ProviderData,
} from "./services/signing-providers.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { buildSignerRevisionKey } from "./services/storage-keys.ts";
import type { SignerCheckMethod } from "./signer-checks.ts";
import {
  prepareSignerSubmission,
  submitSigningForToken,
  SigningMutationError,
  type SigningRequestMeta,
} from "./signing.ts";
import { readEnv, resolveAppUrl, type EnvSource } from "./utils/env.ts";

// Signing with a certificate in the signer's own name (eIDAS AdES or QES).
//
// 1. start: the signer fills in their fields as usual and presses Continue.
//    Their submission is checked as a submit would be, their revision of the
//    PDF is prepared on top of the last one (see pdf-revision.ts), and the
//    provider is given its hash. The signer goes to the provider.
// 2. resume: the provider sends the signer back here. Its signature is
//    checked against the revision's hash (signer-cms.ts), put into the
//    revision, and the submission is saved with that revision, exactly as a
//    submit saves it. The last signer's revision becomes the signed PDF.
//
// The session keeps what the signer submitted, their signing link and the
// provider's working state, encrypted, for at most SESSION_SECONDS.

const SESSION_SECONDS = 30 * 60;
const SECRET_CONTEXT = "signudoc/provider-session/v1";

export const PROVIDER_RETURN_PATH = "/api/signing/provider/return";

type SessionSecret = {
  providerData: ProviderData;
  submission: unknown;
  token: string;
};

type SessionRow = {
  baseSha256: string | null;
  contentDigest: string;
  envelopeId: string;
  expiresAt: number;
  id: string;
  level: SignatureLevel;
  provider: string;
  revisionKey: string;
  secretData: string;
  state: "completed" | "failed" | "pending" | "signing";
  submittedAt: number;
};

/** Why a signer is sent back to the signing page, as the page shows it. */
export type ProviderSigningProblem = "cancelled" | "expired" | "failed";

export class ProviderSigningError extends Error {
  readonly problem: ProviderSigningProblem;
  readonly token: string | null;

  constructor(
    message: string,
    problem: ProviderSigningProblem,
    token: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderSigningError";
    this.problem = problem;
    this.token = token;
  }
}

function sealSecret(secret: SessionSecret, env: EnvSource): string {
  return encryptPrivateKey(
    JSON.stringify(secret),
    secretKeyFor(SECRET_CONTEXT, env),
  );
}

function openSecret(value: string, env: EnvSource): SessionSecret | null {
  const json = decryptPrivateKey(value, secretKeyFor(SECRET_CONTEXT, env));

  return json ? (JSON.parse(json) as SessionSecret) : null;
}

function returnUrlFor(env: EnvSource): string {
  const appUrl = resolveAppUrl(env);

  if (!appUrl) {
    throw new SigningMutationError(
      "Signing with a provider needs the install's public address (APP_URL).",
      503,
    );
  }

  return new URL(PROVIDER_RETURN_PATH, appUrl).toString();
}

function signatureFieldName(name: string, index: number): string {
  // Dots separate the parts of a field's name in a PDF form.
  return `Signature ${String(index + 1)} - ${name.replace(/\./g, " ").slice(0, 80)}`;
}

/**
 * Prepares the signer's revision and sends them to the provider. Returns
 * where to send the signer's browser.
 */
export async function startProviderSigning(
  token: string,
  input: unknown,
  {
    database = getDb(),
    env = process.env,
    language = null,
    storageService = createStorageService(),
    verifiedMethods = [],
  }: {
    database?: DbPool;
    env?: EnvSource;
    language?: string | null;
    storageService?: StorageService;
    verifiedMethods?: readonly SignerCheckMethod[];
  } = {},
): Promise<{ redirectUrl: string }> {
  const prepared = await prepareSignerSubmission(token, input, {
    database,
    verifiedMethods,
  });
  const { context, submittedAt } = prepared;
  const level = context.envelope.signatureLevel as SignatureLevel;
  const provider = signingProviderById(
    context.envelope.signatureProvider ?? "",
    env,
  );

  if (!provider) {
    throw new SigningMutationError(
      "The signing provider this document was sent with is not set up any more. Ask the sender to send it again.",
      503,
    );
  }

  const returnUrl = returnUrlFor(env);
  let base: Uint8Array;

  if (context.envelope.revisionKey) {
    base = (await storageService.getObject(context.envelope.revisionKey)).body;

    if (sha256Hex(base) !== context.envelope.revisionSha256) {
      throw new SigningMutationError(
        "The signed document stored for this envelope has changed. Ask the sender for help.",
        500,
      );
    }
  } else {
    const source = (
      await storageService.getObject(context.envelope.sourcePdfKey)
    ).body;

    if (sha256Hex(source) !== context.envelope.sourcePdfHash) {
      throw new SigningMutationError(
        "The stored document no longer matches the one that was sent for signing.",
        500,
      );
    }

    base = await prepareRevisionZero(source);
  }

  const signer = context.signer;
  const revision = await prepareSignerRevision(base, {
    fields: prepared.signerFields,
    images: prepared.images,
    signature: {
      fieldName: signatureFieldName(signer.name, prepared.signerIndex),
      name: signer.name,
      reason:
        level === "qualified"
          ? "Qualified electronic signature"
          : "Advanced electronic signature",
      signingTime: new Date(submittedAt * 1000),
    },
  });
  const sessionId = randomBytes(24).toString("base64url");
  const revisionKey = buildSignerRevisionKey({
    envelopeId: context.envelope.id,
    sessionId,
    sourcePdfKey: context.envelope.sourcePdfKey,
    userId: context.envelope.userId,
  });

  await storageService.putObject({
    body: revision.bytes,
    contentType: "application/pdf",
    key: revisionKey,
  });

  let step;

  try {
    step = await provider.start({
      contentDigest: revision.digest,
      documentName: context.envelope.title,
      language,
      level,
      returnUrl,
      signer: { email: signer.email, name: signer.name },
      state: sessionId,
    });
  } catch (error) {
    await storageService.deleteObject(revisionKey).catch(() => undefined);
    console.error(`[signing] ${provider.name} refused to start:`, error);
    throw new SigningMutationError(
      `${provider.name} could not start the signature. Try again in a moment.`,
      502,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const earlier = await database.query<{ revisionKey: string }>(
    `
      UPDATE provider_signing_sessions
      SET state = 'failed'
      WHERE signer_id = $1 AND state = 'pending'
      RETURNING revision_key AS "revisionKey"
    `,
    [signer.id],
  );

  await database.query(
    `
      INSERT INTO provider_signing_sessions (
        id, envelope_id, signer_id, provider, level, state, base_sha256,
        revision_key, content_digest, secret_data, submitted_at, created_at,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12)
    `,
    [
      sessionId,
      context.envelope.id,
      signer.id,
      provider.id,
      level,
      context.envelope.revisionSha256 ?? null,
      revisionKey,
      revision.digest.toString("hex"),
      sealSecret({ providerData: step.data, submission: input, token }, env),
      submittedAt,
      now,
      now + SESSION_SECONDS,
    ],
  );

  // Only one trip to the provider at a time: an earlier one, in another tab,
  // can no longer finish.
  for (const row of earlier.rows) {
    await storageService.deleteObject(row.revisionKey).catch(() => undefined);
  }

  return { redirectUrl: step.redirectUrl };
}

async function failSession(
  session: SessionRow,
  database: DbPool,
  storageService: StorageService,
) {
  const failed = await database.query(
    `
      UPDATE provider_signing_sessions
      SET state = 'failed'
      WHERE id = $1 AND state IN ('pending', 'signing')
    `,
    [session.id],
  );

  if (failed.rowCount === 1) {
    await storageService
      .deleteObject(session.revisionKey)
      .catch(() => undefined);
  }
}

function signedContentDigest(bytes: Uint8Array): Buffer {
  const signature = findSignatures(bytes).at(-1)!;
  const [, firstLength, restStart, restLength] = signature.byteRange;

  return createHash("sha256")
    .update(bytes.subarray(0, firstLength))
    .update(bytes.subarray(restStart, restStart + restLength))
    .digest();
}

/**
 * The signer is back from the provider. Either they are sent on to its next
 * step, or the signature is checked and the submission saved. Returns where
 * to send the signer's browser.
 */
export async function resumeProviderSigning(
  sessionId: string,
  query: URLSearchParams,
  {
    database = getDb(),
    env = process.env,
    requestMeta = {},
    storageService = createStorageService(),
    verifiedMethodsFor,
  }: {
    database?: DbPool;
    env?: EnvSource;
    requestMeta?: SigningRequestMeta;
    storageService?: StorageService;
    /** The signer checks this browser has passed for the signing link. */
    verifiedMethodsFor: (token: string) => readonly SignerCheckMethod[];
  },
): Promise<{ redirectPath: string } | { redirectUrl: string }> {
  const session = await queryOne<SessionRow>(
    database,
    `
      SELECT
        id,
        envelope_id AS "envelopeId",
        provider,
        level,
        state,
        base_sha256 AS "baseSha256",
        revision_key AS "revisionKey",
        content_digest AS "contentDigest",
        secret_data AS "secretData",
        submitted_at AS "submittedAt",
        expires_at AS "expiresAt"
      FROM provider_signing_sessions
      WHERE id = $1
    `,
    [sessionId],
  );
  const secret = session ? openSecret(session.secretData, env) : null;

  if (!session || !secret) {
    throw new ProviderSigningError(
      "This signing session is not known here.",
      "expired",
      null,
    );
  }

  // Another return for this session (a reload, or the provider calling back
  // twice) is finishing it. Leave it to finish: failing the session here
  // would delete the revision it is saving.
  if (session.state === "signing" || session.state === "completed") {
    throw new ProviderSigningError(
      "This signing session is already being completed.",
      "expired",
      secret.token,
    );
  }

  if (
    session.state !== "pending" ||
    session.expiresAt < Math.floor(Date.now() / 1000)
  ) {
    await failSession(session, database, storageService);
    throw new ProviderSigningError(
      "This signing session has ended.",
      "expired",
      secret.token,
    );
  }

  const provider = signingProviderById(session.provider, env);

  if (!provider) {
    await failSession(session, database, storageService);
    throw new ProviderSigningError(
      "The signing provider is not set up any more.",
      "failed",
      secret.token,
    );
  }

  const contentDigest = Buffer.from(session.contentDigest, "hex");
  let step;

  try {
    step = await provider.resume({
      contentDigest,
      data: secret.providerData,
      query,
      returnUrl: returnUrlFor(env),
      state: session.id,
    });
  } catch (error) {
    await failSession(session, database, storageService);
    console.error(`[signing] ${provider.name} did not sign:`, error);
    throw new ProviderSigningError(
      error instanceof SigningProviderError ? error.message : "Signing failed.",
      query.get("error") || /cancel/i.test(String(error))
        ? "cancelled"
        : "failed",
      secret.token,
      { cause: error },
    );
  }

  if (step.kind === "redirect") {
    await database.query(
      `
        UPDATE provider_signing_sessions
        SET secret_data = $1
        WHERE id = $2 AND state = 'pending'
      `,
      [sealSecret({ ...secret, providerData: step.data }, env), session.id],
    );

    return { redirectUrl: step.redirectUrl };
  }

  // One return finishes the session. A second one (a reload, or the
  // provider calling back twice) stops here instead of writing the revision
  // again.
  const claimed = await database.query(
    `
      UPDATE provider_signing_sessions
      SET state = 'signing'
      WHERE id = $1 AND state = 'pending'
    `,
    [session.id],
  );

  if (claimed.rowCount !== 1) {
    throw new ProviderSigningError(
      "This signing session is already being completed.",
      "expired",
      secret.token,
    );
  }

  try {
    const checked = checkSignerSignature(step.cms, contentDigest, {
      level: session.level,
    });
    const timestampUrl = readEnv(env, "SEAL_TIMESTAMP_URL");
    let cms = step.cms;
    let timestamped = checked.timestamped;

    // A signature timestamp (PAdES B-T) proves when the signer signed. The
    // provider usually adds one; when it did not, the install's own
    // time-stamping service can.
    if (!timestamped && timestampUrl) {
      try {
        cms = await addSignatureTimestamp(cms, (imprint) =>
          requestDocumentTimestamp(imprint, timestampUrl),
        );
        timestamped = true;
      } catch (error) {
        console.warn("[signing] The signature timestamp failed:", error);
      }
    }

    const prepared = (await storageService.getObject(session.revisionKey)).body;

    if (!signedContentDigest(prepared).equals(contentDigest)) {
      throw new SignerSignatureError(
        "The prepared document changed while the signer was away.",
      );
    }

    const signed = fillSignature(prepared, cms);
    const signedSha256 = sha256Hex(signed);

    await storageService.putObject({
      body: signed,
      contentType: "application/pdf",
      key: session.revisionKey,
    });

    const result = await submitSigningForToken(
      secret.token,
      secret.submission,
      {
        database,
        providerSignature: {
          baseSha256: session.baseSha256,
          evidence: {
            certificateIssuer: checked.issuer,
            certificateSerialNumber: checked.serialNumber,
            certificateSubject: checked.subject,
            certificateValidTo: Math.floor(checked.validTo.getTime() / 1000),
            level: session.level,
            method: step.method ?? null,
            provider: provider.name,
            qualified: checked.qualified,
            timestamped,
          },
          revision: {
            bytes: signed,
            key: session.revisionKey,
            sha256: signedSha256,
          },
          sessionId: session.id,
          submittedAt: session.submittedAt,
        },
        requestMeta,
        storageService,
        verifiedMethods: verifiedMethodsFor(secret.token),
      },
    );

    // The revision this one was built on is inside it now. Saving the
    // submission deleted it (see commitProviderRevision in signing.ts).
    return { redirectPath: result.redirectPath };
  } catch (error) {
    await failSession(session, database, storageService);

    if (error instanceof SignerSignatureError) {
      console.error("[signing] The provider's signature was refused:", error);
      throw new ProviderSigningError(error.message, "failed", secret.token, {
        cause: error,
      });
    }

    throw new ProviderSigningError(
      error instanceof Error ? error.message : "Signing failed.",
      "failed",
      secret.token,
      { cause: error },
    );
  }
}
