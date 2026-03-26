import path from "node:path";

const STORAGE_ROOT_SEGMENT = "users";
const ENVELOPE_ROOT_SEGMENT = "envelopes";
const CERTIFICATE_ROOT_SEGMENT = "certificates";
const INTERNAL_CERTIFICATE_FILE_NAME = "internal.pdf";
const RECIPIENT_CERTIFICATE_FILE_NAME = "recipient.pdf";
const LEGACY_INTERNAL_EVIDENCE_FILE_NAME = "internal.json";
const LEGACY_RECIPIENT_EVIDENCE_FILE_NAME = "recipient.json";

export type CertificateAudience = "internal" | "recipient";

type EnvelopeStorageIdentity = {
  envelopeId: string;
  userId: string;
};

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
