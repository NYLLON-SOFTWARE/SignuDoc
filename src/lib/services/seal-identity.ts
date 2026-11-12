import {
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
  createSelfSignedSealIdentity,
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

  if (!timestampUrl) {
    return saveSealedPdf(pdfDocument, sealIdentity, options);
  }

  try {
    return await saveSealedPdf(
      await clonePdf(pdfDocument),
      sealIdentity,
      options,
    );
  } catch (error) {
    // A time-stamping service that is down must not stop a signing. The
    // document is still sealed, only without the independent time.
    console.error("[seal] Timestamping failed; sealing without it.", error);
    return saveSealedPdf(pdfDocument, sealIdentity, {
      ...options,
      timestampUrl: null,
    });
  }
}

async function clonePdf(pdfDocument: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await pdfDocument.save({ useObjectStreams: false }));
}
