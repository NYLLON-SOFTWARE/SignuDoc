import path from "node:path";

const STORAGE_ROOT_SEGMENT = "users";
const ENVELOPE_ROOT_SEGMENT = "envelopes";
const CERTIFICATE_ROOT_SEGMENT = "certificates";
const INTERNAL_CERTIFICATE_FILE_NAME = "internal.pdf";
const RECIPIENT_CERTIFICATE_FILE_NAME = "recipient.pdf";
const LEGACY_INTERNAL_EVIDENCE_FILE_NAME = "internal.json";
const LEGACY_RECIPIENT_EVIDENCE_FILE_NAME = "recipient.json";

const PENDING_UPLOAD_ROOT_SEGMENT = "uploads";
const PENDING_UPLOAD_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

export type CertificateAudience = "internal" | "recipient";

type EnvelopeStorageIdentity = {
  envelopeId: string;
  userId: string;
};

/**
 * Where a user's browser may put a PDF before the app has looked at it.
 * Ends with a slash; the browser adds "<uuid>.pdf". Nothing under this
 * prefix is trusted: the app reads the file, validates it, and stores its
 * own copy under the envelope's key.
 */
export function buildPendingUploadPrefix(userId: string): string {
  return `${PENDING_UPLOAD_ROOT_SEGMENT}/${userId}/`;
}

/** True only for a pending upload key that belongs to this user. */
export function isPendingUploadKey(key: string, userId: string): boolean {
  const prefix = buildPendingUploadPrefix(userId);

  return (
    userId.length > 0 &&
    !userId.includes("/") &&
    key.startsWith(prefix) &&
    PENDING_UPLOAD_NAME_PATTERN.test(key.slice(prefix.length))
  );
}

export function buildEnvelopePrefix(input: EnvelopeStorageIdentity): string {
  return path.posix.join(
    STORAGE_ROOT_SEGMENT,
    input.userId,
    ENVELOPE_ROOT_SEGMENT,
    input.envelopeId,
  );
}

export function buildEnvelopeOriginalPdfKey(
  input: EnvelopeStorageIdentity,
): string {
  return path.posix.join(buildEnvelopePrefix(input), "original.pdf");
}

/**
 * The picture of the first page shown on the dashboard. It sits beside the
 * original so that whatever removes an envelope's files can find it without
 * a database column: it may or may not exist.
 */
export function buildEnvelopeThumbnailKey(
  input: EnvelopeStorageIdentity,
): string {
  return path.posix.join(buildEnvelopePrefix(input), "thumbnail.jpg");
}

export function buildEnvelopeSignedPdfKey(
  input: EnvelopeStorageIdentity,
): string {
  return path.posix.join(buildEnvelopePrefix(input), "final.pdf");
}

export function buildEnvelopeCertificateKey(
  input: EnvelopeStorageIdentity & {
    audience: CertificateAudience;
  },
): string {
  const fileName =
    input.audience === "internal"
      ? INTERNAL_CERTIFICATE_FILE_NAME
      : RECIPIENT_CERTIFICATE_FILE_NAME;

  return path.posix.join(
    buildEnvelopePrefix(input),
    CERTIFICATE_ROOT_SEGMENT,
    fileName,
  );
}

export function buildSignatureImageKey(
  input: EnvelopeStorageIdentity & {
    fieldId: string;
  },
): string {
  return path.posix.join(
    buildEnvelopePrefix(input),
    "signatures",
    `${input.fieldId}.png`,
  );
}

export function getRecipientCertificateKey(evidenceKey: string): string {
  const normalizedKey = evidenceKey.trim().replaceAll("\\", "/");

  if (normalizedKey.endsWith(`/${INTERNAL_CERTIFICATE_FILE_NAME}`)) {
    return `${normalizedKey.slice(0, -INTERNAL_CERTIFICATE_FILE_NAME.length)}${RECIPIENT_CERTIFICATE_FILE_NAME}`;
  }

  if (normalizedKey.endsWith(`/${LEGACY_INTERNAL_EVIDENCE_FILE_NAME}`)) {
    return `${normalizedKey.slice(0, -LEGACY_INTERNAL_EVIDENCE_FILE_NAME.length)}${LEGACY_RECIPIENT_EVIDENCE_FILE_NAME}`;
  }

  throw new Error(
    `Cannot derive recipient certificate key from "${normalizedKey}".`,
  );
}
