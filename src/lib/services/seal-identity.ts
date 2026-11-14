import {
  X509Certificate,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { PDFDocument } from "pdf-lib";

import { getDb, withTransaction, type DbPool } from "../db/connection.ts";
import { getBranding } from "../settings.ts";
import {
  isProduction,
  readEnv,
  resolveAuthSecret,
  type EnvSource,
} from "../utils/env.ts";
import {
  addLongTermValidation,
  isSelfSigned,
  parseCertificate,
  type ValidationFetch,
} from "./pdf-ltv.ts";
import {
  createSelfSignedSealIdentity,
  requestDocumentTimestamp,
  saveSealedPdf,
  sealIdentityFromPkcs12,
  type SealIdentity,
  type SealOptions,
} from "./pdf-seal.ts";

// Where the install's seal key comes from:
//
// 1. SEAL_P12_BASE64 (+ SEAL_P12_PASSWORD): a certificate the organization
//    bought from a certificate authority, so readers show its name as
//    verified. Used as given, never stored.
// 2. Otherwise a key the install makes for itself the first time it seals a
//    document. The private key is kept in the seal_keys table, encrypted with
//    a key derived from the auth secret. If that secret changes and the old
//    key can no longer be read, a new one is made; documents sealed before
//    still verify, because each carries its own certificate.

const KEY_CONTEXT = "signudoc/seal-key/v1";
const SEAL_KEY_LOCK_ID = 746108325;

type CachedIdentity = { identity: SealIdentity; source: string };

declare global {
  var __signudocSealIdentity: CachedIdentity | undefined;
}

function encryptionKey(env: EnvSource): Buffer {
  const secret = resolveAuthSecret(env);

  if (!secret) {
    if (isProduction(env)) {
      throw new Error(
        "Sealing documents needs BETTER_AUTH_SECRET, or a database password of at least 12 characters.",
      );
    }

    // Local development without a password: nothing worth protecting.
    return Buffer.from(
      hkdfSync("sha256", "signudoc-development", "", KEY_CONTEXT, 32),
    );
  }

  return Buffer.from(hkdfSync("sha256", secret, "", KEY_CONTEXT, 32));
}

export function encryptPrivateKey(pem: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(pem, "utf8"), cipher.final()]);

  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

export function decryptPrivateKey(value: string, key: Buffer): string | null {
  const [version, iv, tag, body] = value.split(".");

  if (version !== "v1" || !iv || !tag || !body) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );

    decipher.setAuthTag(Buffer.from(tag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

function identityFromEnvironment(env: EnvSource): SealIdentity | null {
  const bundle = readEnv(env, "SEAL_P12_BASE64");

  if (!bundle) {
    return null;
  }

  return sealIdentityFromPkcs12(
    new Uint8Array(Buffer.from(bundle, "base64")),
    readEnv(env, "SEAL_P12_PASSWORD") ?? "",
  );
}

type SealKeyRow = {
  certificatePem: string;
  encryptedPrivateKey: string;
  id: string;
};

async function identityFromDatabase(
  env: EnvSource,
  database: DbPool,
): Promise<CachedIdentity> {
  const key = encryptionKey(env);
  // Read before the transaction: settings come through another connection,
  // which a full pool could not give while this one waits on the lock.
  const branding = await getBranding(env);

  return withTransaction(async (tx) => {
    // One instance makes the key; any other waits here and then reads it.
    await tx.query("SELECT pg_advisory_xact_lock($1)", [SEAL_KEY_LOCK_ID]);

    const existing = await tx.query<SealKeyRow>(
      `
        SELECT
          id,
          certificate_pem AS "certificatePem",
          encrypted_private_key AS "encryptedPrivateKey"
        FROM seal_keys
        WHERE retired_at IS NULL
        LIMIT 1
      `,
    );
    const row = existing.rows[0];

    if (row) {
      const privateKeyPem = decryptPrivateKey(row.encryptedPrivateKey, key);

      if (privateKeyPem) {
        return {
          identity: {
            certificateChainPem: [row.certificatePem],
            privateKeyPem,
          },
          source: `database:${row.id}`,
        };
      }

      console.warn(
        "[seal] The stored seal key cannot be read with the current auth secret; making a new one.",
      );
    }

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const generated = createSelfSignedSealIdentity({
      commonName: `${branding.organizationName ?? branding.productName} document seal`,
      organization: branding.organizationName,
      privateKeyPem: privateKey,
      publicKeyPem: publicKey,
    });
    const now = Math.floor(Date.now() / 1000);
    const id = randomUUID();

    await tx.query(
      `UPDATE seal_keys SET retired_at = $1 WHERE retired_at IS NULL`,
      [now],
    );
    await tx.query(
      `
        INSERT INTO seal_keys (id, certificate_pem, encrypted_private_key, created_at)
        VALUES ($1, $2, $3, $4)
      `,
      [id, generated.certificatePem, encryptPrivateKey(privateKey, key), now],
    );

    return { identity: generated, source: `database:${id}` };
  }, database);
}

export async function getSealIdentity({
  database = getDb(),
  env = process.env,
}: { database?: DbPool; env?: EnvSource } = {}): Promise<SealIdentity> {
  const cached = globalThis.__signudocSealIdentity;

  if (cached) {
    return cached.identity;
  }

  const fromEnvironment = identityFromEnvironment(env);
  const resolved = fromEnvironment
    ? { identity: fromEnvironment, source: "environment" }
    : await identityFromDatabase(env, database);

  globalThis.__signudocSealIdentity = resolved;

  return resolved.identity;
}

/** Forgets the loaded key, for tests. */
export function resetSealIdentityCache() {
  globalThis.__signudocSealIdentity = undefined;
}

export type SealPurpose = "signed-document" | "certificate";

/**
 * Saves a finished PDF sealed with the install's key, so any later change to
 * it shows in a PDF reader.
 */
export async function saveInstallSealedPdf(
  pdfDocument: PDFDocument,
  purpose: SealPurpose,
  {
    database,
    env = process.env,
    identity,
  }: { database?: DbPool; env?: EnvSource; identity?: SealIdentity } = {},
): Promise<Uint8Array> {
  const sealIdentity = identity ?? (await getSealIdentity({ database, env }));
  const branding = await getBranding(env);
  const timestampUrl = readEnv(env, "SEAL_TIMESTAMP_URL") ?? null;
  const options: SealOptions = {
    contactInfo: branding.supportAddress ?? "",
    name: branding.organizationName ?? branding.productName,
    reason:
      purpose === "signed-document"
        ? `Signed with ${branding.productName}; sealed so that later changes are detectable`
        : `${branding.productName} audit certificate`,
    timestampUrl,
  };

  return sealForTheLongTerm(pdfDocument, sealIdentity, options);
}

/**
 * Seals the document (PAdES B-B, or B-T with a time-stamping service), then
 * adds what keeps the seal checkable for years: the certificates and
 * revocation answers (B-LT) and an archive timestamp over them (B-LTA).
 * Each step after the first only adds to the file, and is skipped with a
 * logged reason when a service it needs cannot be reached.
 */
export async function sealForTheLongTerm(
  pdfDocument: PDFDocument,
  identity: SealIdentity,
  options: SealOptions,
  { fetch }: { fetch?: ValidationFetch } = {},
): Promise<Uint8Array> {
  const timestampUrl = options.timestampUrl ?? null;
  // A self-made certificate has no issuer to ask about, so without a
  // timestamp there is nothing to add for it.
  const fromAuthority = isCertificateAuthoritySeal(identity);

  if (!timestampUrl) {
    const sealed = await saveSealedPdf(pdfDocument, identity, options);

    return fromAuthority ? withLongTermValidation(sealed, null, fetch) : sealed;
  }

  let sealed: Uint8Array;

  try {
    sealed = await saveSealedPdf(
      await clonePdf(pdfDocument),
      identity,
      options,
    );
  } catch (error) {
    // A time-stamping service that is down must not stop a signing. The
    // document is still sealed, only without the independent time.
    console.error("[seal] Timestamping failed; sealing without it.", error);
    sealed = await saveSealedPdf(pdfDocument, identity, {
      ...options,
      timestampUrl: null,
    });

    return fromAuthority ? withLongTermValidation(sealed, null, fetch) : sealed;
  }

  return withLongTermValidation(sealed, timestampUrl, fetch);
}

/** Whether the seal certificate was issued by someone else. */
function isCertificateAuthoritySeal(identity: SealIdentity): boolean {
  try {
    return !isSelfSigned(
      parseCertificate(
        new X509Certificate(identity.certificateChainPem[0]!).raw,
      ),
    );
  } catch {
    return false;
  }
}

/**
 * Adds long-term validation (PAdES B-LT) and, with a time-stamping service,
 * an archive timestamp (B-LTA). It only adds to a seal already made, so
 * when a certificate authority or the time-stamping service cannot be
 * reached the document keeps the seal it has, and the reason is logged.
 */
async function withLongTermValidation(
  sealed: Uint8Array,
  timestampUrl: string | null,
  fetch: ValidationFetch | undefined,
): Promise<Uint8Array> {
  try {
    const result = await addLongTermValidation(sealed, {
      fetch,
      timestamp: timestampUrl
        ? (digest) => requestDocumentTimestamp(digest, timestampUrl)
        : null,
    });

    if (result.revoked.length > 0) {
      console.error(
        `[seal] A certificate authority says these certificates are revoked: ${result.revoked.join("; ")}. Readers will not accept the seal. Replace SEAL_P12_BASE64.`,
      );
    }

    if (result.problems.length > 0) {
      console.warn(
        `[seal] Long-term validation is incomplete: ${result.problems.join(" ")}`,
      );
    }

    return result.bytes;
  } catch (error) {
    console.error(
      "[seal] Adding long-term validation failed; keeping the seal without it.",
      error,
    );
    return sealed;
  }
}

async function clonePdf(pdfDocument: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await pdfDocument.save({ useObjectStreams: false }));
}
