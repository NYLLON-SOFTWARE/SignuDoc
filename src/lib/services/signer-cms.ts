import {
  constants,
  createHash,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import {
  algorithm,
  children,
  contentBytes,
  contextTag,
  der,
  elementBytes,
  encode,
  encodeSmallInteger,
  readOid,
  readTlv,
  TAG,
  type Tlv,
} from "./der.ts";
import { parseCertificate, type Certificate } from "./pdf-ltv.ts";

// The CMS of one signer's own signature (CAdES, as PAdES uses it).
//
// A signing provider either returns the whole CMS (eID Easy), or signs a
// hash and leaves the CMS to us (the Cloud Signature Consortium API). Either
// way, before a signature goes into a document it is checked here: that it
// signs this revision's bytes, that the signature verifies with the
// certificate it names, and, for a qualified signature, that the certificate
// says it is qualified and its key is on a qualified signature creation
// device. Whether the certificate's issuer is a qualified trust service
// provider on the EU trusted list is for the reader to check: Acrobat and
// the EU's validation service do, from the list.

export const CMS_OIDS = {
  contentType: "1.2.840.113549.1.9.3",
  data: "1.2.840.113549.1.7.1",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4",
  ecPublicKey: "1.2.840.10045.2.1",
  messageDigest: "1.2.840.113549.1.9.4",
  mgf1: "1.2.840.113549.1.1.8",
  qcCompliance: "0.4.0.1862.1.1",
  qcSscd: "0.4.0.1862.1.4",
  qcTypeSignature: "0.4.0.1862.1.6.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  rsaPss: "1.2.840.113549.1.1.10",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha384WithRsa: "1.2.840.113549.1.1.12",
  sha512: "2.16.840.1.101.3.4.2.3",
  sha512WithRsa: "1.2.840.113549.1.1.13",
  signedData: "1.2.840.113549.1.7.2",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  signingTime: "1.2.840.113549.1.9.5",
  sha1: "1.3.14.3.2.26",
  timeStampToken: "1.2.840.113549.1.9.16.2.14",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
} as const;

const HASHES: Record<string, string> = {
  [CMS_OIDS.sha1]: "sha1",
  [CMS_OIDS.sha256]: "sha256",
  [CMS_OIDS.sha384]: "sha384",
  [CMS_OIDS.sha512]: "sha512",
};

export class SignerSignatureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SignerSignatureError";
  }
}

// --- Building ------------------------------------------------------------

function attribute(type: string, value: Uint8Array): Buffer {
  return der.sequence(der.oid(type), der.set(value));
}

/** DER SET OF: the elements sorted by their encoding (X.690 11.6). */
function sortedSet(items: Buffer[]): Buffer {
  return der.set(...[...items].sort(Buffer.compare));
}

/**
 * The signed attributes of a PAdES signature, as the SET whose hash is
 * signed: the content type, the hash of the signed bytes and which
 * certificate signs (ESSCertIDv2 with SHA-256). No signing time: PAdES
 * keeps that in the signature dictionary.
 */
export function buildSignedAttributes({
  certificate,
  contentDigest,
}: {
  certificate: Uint8Array;
  contentDigest: Uint8Array;
}): Buffer {
  const certificateHash = createHash("sha256").update(certificate).digest();

  return sortedSet([
    attribute(CMS_OIDS.contentType, der.oid(CMS_OIDS.data)),
    attribute(CMS_OIDS.messageDigest, der.octets(contentDigest)),
    attribute(
      CMS_OIDS.signingCertificateV2,
      der.sequence(der.sequence(der.sequence(der.octets(certificateHash)))),
    ),
  ]);
}

/** Whether the certificate's key is an elliptic curve key (else RSA). */
export function hasEcKey(certificate: Certificate): boolean {
  const bytes = certificate.der;
  const tbs = children(bytes, readTlv(bytes))[0]!;
  const fields = children(bytes, tbs);
  const offset = fields[0]?.tag === contextTag(0) ? 1 : 0;
  const spki = fields[offset + 5]!;
  const keyAlgorithm = children(bytes, children(bytes, spki)[0]!)[0]!;

  return readOid(bytes, keyAlgorithm) === CMS_OIDS.ecPublicKey;
}

/** The algorithm a signature value was made with, for the SignerInfo. */
export function signatureAlgorithmFor(certificate: Certificate): Buffer {
  return hasEcKey(certificate)
    ? der.sequence(der.oid(CMS_OIDS.ecdsaSha256))
    : algorithm(CMS_OIDS.sha256WithRsa);
}

/**
 * Whether a signature is an ECDSA-Sig-Value in DER: a SEQUENCE of exactly
 * two positive INTEGERs, minimally encoded, filling the whole value. Raw
 * r and s can start with the bytes of a SEQUENCE by chance, but not pass
 * all of this.
 */
function isDerEcdsaSignature(signature: Buffer): boolean {
  try {
    const outer = readTlv(signature);

    if (outer.tag !== TAG.sequence || outer.end !== signature.length) {
      return false;
    }

    const parts = children(signature, outer);

    return (
      parts.length === 2 &&
      parts.every((part) => {
        const value = contentBytes(signature, part);

        return (
          part.tag === TAG.integer &&
          value.length > 0 &&
          // Positive, and no needless leading zero.
          (value[0]! & 0x80) === 0 &&
          !(value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0)
        );
      })
    );
  } catch {
    return false;
  }
}

/**
 * An ECDSA signature as DER, from the raw r and s some services return.
 * A signature already in DER is returned as it is.
 */
export function ecdsaSignatureAsDer(signature: Buffer): Buffer {
  if (isDerEcdsaSignature(signature)) {
    return signature;
  }

  const half = signature.length / 2;
  const integer = (value: Buffer) => {
    let start = 0;

    while (start < value.length - 1 && value[start] === 0) {
      start += 1;
    }

    const trimmed = value.subarray(start);

    return encode(
      TAG.integer,
      trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed,
    );
  };

  return der.sequence(
    integer(signature.subarray(0, half)),
    integer(signature.subarray(half)),
  );
}

/** A CMS SignedData (detached) from parts signed elsewhere. */
export function assembleSignedData({
  certificates,
  signature,
  signatureAlgorithm,
  signedAttributes,
  unsignedAttributes = [],
}: {
  /** The signer's certificate first, then its chain. */
  certificates: readonly Buffer[];
  signature: Buffer;
  signatureAlgorithm: Buffer;
  /** As `buildSignedAttributes` made them: a DER SET. */
  signedAttributes: Buffer;
  unsignedAttributes?: readonly Buffer[];
}): Buffer {
  const signer = parseCertificate(certificates[0]!);
  const signedAttributesTlv = readTlv(signedAttributes);
  const signerInfo = der.sequence(
    encodeSmallInteger(1),
    der.sequence(signer.issuerName, encode(TAG.integer, signer.serial)),
    algorithm(CMS_OIDS.sha256),
    // [0] IMPLICIT: the same content, under the context tag.
    encode(contextTag(0), contentBytes(signedAttributes, signedAttributesTlv)),
    signatureAlgorithm,
    der.octets(signature),
    ...(unsignedAttributes.length > 0
      ? [encode(contextTag(1), ...unsignedAttributes)]
      : []),
  );
  const signedData = der.sequence(
    encodeSmallInteger(1),
    der.set(algorithm(CMS_OIDS.sha256)),
    der.sequence(der.oid(CMS_OIDS.data)),
    encode(contextTag(0), ...certificates),
    der.set(signerInfo),
  );

  return der.sequence(
    der.oid(CMS_OIDS.signedData),
    encode(contextTag(0), signedData),
  );
}

// --- Reading -------------------------------------------------------------

type ParsedSignerInfo = {
  bytes: Buffer;
  certificates: Buffer[];
  digestAlgorithm: string;
  signature: Buffer;
  signatureAlgorithm: { oid: string; parameters: Tlv | null };
  /** The signed attributes, re-tagged as the SET that was signed. */
  signedAttributes: Buffer;
  signedAttributeValues: Map<string, Tlv[]>;
  signerIdentifier: Tlv;
  unsignedAttributeValues: Map<string, Tlv[]>;
};

function readAttributes(bytes: Buffer, tlv: Tlv): Map<string, Tlv[]> {
  const values = new Map<string, Tlv[]>();

  for (const item of children(bytes, tlv)) {
    const [id, set] = children(bytes, item);
    const oid = readOid(bytes, id!);

    if (values.has(oid)) {
      throw new SignerSignatureError(`The attribute ${oid} appears twice.`);
    }

    values.set(oid, children(bytes, set!));
  }

  return values;
}

function readSignedData(cms: Buffer): {
  parts: Tlv[];
  signedData: Tlv;
} {
  const contentInfo = readTlv(cms);

  if (contentInfo.end !== cms.length) {
    throw new SignerSignatureError("The signature has data after its end.");
  }

  const [type, wrapped] = children(cms, contentInfo);

  if (readOid(cms, type!) !== CMS_OIDS.signedData) {
    throw new SignerSignatureError("The signature is not a CMS SignedData.");
  }

  const signedData = children(cms, wrapped!)[0]!;

  return { parts: children(cms, signedData), signedData };
}

/**
 * The one SignerInfo of a CMS SignedData. A signer's signature is detached
 * (the content type only, no content); a timestamp token carries its TSTInfo
 * as the content, returned here as `content`.
 */
function readSignerInfo(
  cms: Buffer,
  kind: "detached" | "timestamp" = "detached",
): ParsedSignerInfo & { content: Buffer | null } {
  const { parts } = readSignedData(cms);
  const encapsulated = parts[2];
  const encapsulatedParts = encapsulated ? children(cms, encapsulated) : [];
  let content: Buffer | null = null;

  if (kind === "detached") {
    if (
      encapsulatedParts.length !== 1 ||
      readOid(cms, encapsulatedParts[0]!) !== CMS_OIDS.data
    ) {
      throw new SignerSignatureError(
        "The signature is not a detached signature of data.",
      );
    }
  } else {
    const wrapped = encapsulatedParts[1];

    if (
      encapsulatedParts.length !== 2 ||
      readOid(cms, encapsulatedParts[0]!) !== CMS_OIDS.tstInfo ||
      wrapped?.tag !== contextTag(0)
    ) {
      throw new SignerSignatureError("The timestamp token has no TSTInfo.");
    }

    content = contentBytes(cms, children(cms, wrapped)[0]!);
  }

  const certificates = parts
    .filter((part) => part.tag === contextTag(0))
    .flatMap((part) => children(cms, part))
    .filter((item) => item.tag === TAG.sequence)
    .map((item) => elementBytes(cms, item));
  const signerInfos = children(cms, parts[parts.length - 1]!);

  if (signerInfos.length !== 1) {
    throw new SignerSignatureError("The signature must have one signer.");
  }

  const fields = children(cms, signerInfos[0]!);
  const [, signerIdentifier, digestAlgorithm] = fields;
  const signedAttributes = fields.find((field) => field.tag === contextTag(0));

  if (!signedAttributes) {
    throw new SignerSignatureError("The signature has no signed attributes.");
  }

  const afterSigned = fields.slice(fields.indexOf(signedAttributes) + 1);
  const [signatureAlgorithm, signatureValue, unsigned] = afterSigned;
  const algorithmParts = children(cms, signatureAlgorithm!);
  const signed = elementBytes(cms, signedAttributes);

  // The signature covers the attributes encoded as a SET (RFC 5652 5.4).
  signed[0] = TAG.set;

  return {
    bytes: cms,
    certificates,
    content,
    digestAlgorithm: readOid(cms, children(cms, digestAlgorithm!)[0]!),
    signature: contentBytes(cms, signatureValue!),
    signatureAlgorithm: {
      oid: readOid(cms, algorithmParts[0]!),
      parameters:
        algorithmParts[1] && algorithmParts[1].tag !== TAG.null
          ? algorithmParts[1]
          : null,
    },
    signedAttributes: signed,
    signedAttributeValues: readAttributes(cms, signedAttributes),
    signerIdentifier: signerIdentifier!,
    unsignedAttributeValues:
      unsigned && unsigned.tag === contextTag(1)
        ? readAttributes(cms, unsigned)
        : new Map(),
  };
}

function findSigner(
  info: ParsedSignerInfo,
  certificates: readonly Certificate[],
): Certificate {
  const { bytes, signerIdentifier } = info;
  const match = certificates.find((certificate) => {
    if (signerIdentifier.tag === TAG.sequence) {
      const [issuer, serial] = children(bytes, signerIdentifier);

      return (
        elementBytes(bytes, issuer!).equals(certificate.issuerName) &&
        contentBytes(bytes, serial!).equals(certificate.serial)
      );
    }

    // [0] SubjectKeyIdentifier
    return (
      signerIdentifier.tag === contextTag(0, false) &&
      certificate.subjectKeyIdentifier !== null &&
      contentBytes(bytes, signerIdentifier).equals(
        certificate.subjectKeyIdentifier,
      )
    );
  });

  if (!match) {
    throw new SignerSignatureError(
      "The signature does not include the certificate that made it.",
    );
  }

  return match;
}

/**
 * RSASSA-PSS-params (RFC 4055): [0] the hash, [1] the mask generation
 * function, [2] the salt length and [3] the trailer, each SHA-1, MGF1 with
 * SHA-1, 20 and 1 when left out. Node checks a PSS signature with MGF1 over
 * the same hash as the message, so a signature that declares any other mask
 * is refused rather than checked as something it does not say it is.
 */
function readPssParameters(
  bytes: Buffer,
  parameters: Tlv | null,
): { hash: string; saltLength: number } {
  let hash: string | undefined = "sha1";
  let maskHash: string | undefined = "sha1";
  let saltLength = 20;
  let trailer = 1;
  const readNumber = (value: Tlv) => {
    const content = contentBytes(bytes, value);

    return content.length > 0 && content.length <= 6
      ? content.readUIntBE(0, content.length)
      : -1;
  };

  for (const field of parameters ? children(bytes, parameters) : []) {
    const value = children(bytes, field)[0];

    if (!value) {
      maskHash = undefined;
    } else if (field.tag === contextTag(0)) {
      hash = HASHES[readOid(bytes, children(bytes, value)[0]!)];
    } else if (field.tag === contextTag(1)) {
      const [mask, maskParameters] = children(bytes, value);

      maskHash =
        mask && maskParameters && readOid(bytes, mask) === CMS_OIDS.mgf1
          ? HASHES[readOid(bytes, children(bytes, maskParameters)[0]!)]
          : undefined;
    } else if (field.tag === contextTag(2)) {
      saltLength = readNumber(value);
    } else if (field.tag === contextTag(3)) {
      trailer = readNumber(value);
    }
  }

  if (!hash || maskHash !== hash || saltLength < 0 || trailer !== 1) {
    throw new SignerSignatureError(
      "The RSA-PSS signature uses parameters that cannot be checked (its mask has to use the same hash as the signature).",
    );
  }

  return { hash, saltLength };
}

function verifyValue(info: ParsedSignerInfo, key: KeyObject): boolean {
  const { bytes, signatureAlgorithm, signature, signedAttributes } = info;
  const digestHash = HASHES[info.digestAlgorithm];

  switch (signatureAlgorithm.oid) {
    case CMS_OIDS.rsaEncryption:
      return verifySignature(digestHash!, signedAttributes, key, signature);
    case CMS_OIDS.sha256WithRsa:
      return verifySignature("sha256", signedAttributes, key, signature);
    case CMS_OIDS.sha384WithRsa:
      return verifySignature("sha384", signedAttributes, key, signature);
    case CMS_OIDS.sha512WithRsa:
      return verifySignature("sha512", signedAttributes, key, signature);
    case CMS_OIDS.ecdsaSha256:
    case CMS_OIDS.ecdsaSha384:
    case CMS_OIDS.ecdsaSha512: {
      const hash =
        signatureAlgorithm.oid === CMS_OIDS.ecdsaSha256
          ? "sha256"
          : signatureAlgorithm.oid === CMS_OIDS.ecdsaSha384
            ? "sha384"
            : "sha512";

      return verifySignature(
        hash,
        signedAttributes,
        { dsaEncoding: "der", key },
        signature,
      );
    }
    case CMS_OIDS.rsaPss: {
      const { hash, saltLength } = readPssParameters(
        bytes,
        signatureAlgorithm.parameters,
      );

      return verifySignature(
        hash,
        signedAttributes,
        { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength },
        signature,
      );
    }
    default:
      throw new SignerSignatureError(
        `The signature algorithm ${signatureAlgorithm.oid} is not supported.`,
      );
  }
}

function assertSigningCertificate(
  info: ParsedSignerInfo,
  certificate: Certificate,
) {
  const { bytes, signedAttributeValues } = info;
  const v2 = signedAttributeValues.get(CMS_OIDS.signingCertificateV2)?.[0];
  const v1 = signedAttributeValues.get(CMS_OIDS.signingCertificate)?.[0];
  const value = v2 ?? v1;

  if (!value) {
    throw new SignerSignatureError(
      "The signature does not name its certificate (signing-certificate attribute).",
    );
  }

  // SigningCertificate(V2) { certs SEQUENCE OF ESSCertID(v2), ... }
  const first = children(bytes, children(bytes, value)[0]!)[0]!;
  const parts = children(bytes, first);
  let hash = v2 ? "sha256" : "sha1";
  let hashField = parts[0]!;

  if (v2 && parts[0]!.tag === TAG.sequence) {
    hash = HASHES[readOid(bytes, children(bytes, parts[0]!)[0]!)] ?? "";
    hashField = parts[1]!;
  }

  if (
    !hash ||
    !contentBytes(bytes, hashField).equals(
      createHash(hash).update(certificate.der).digest(),
    )
  ) {
    throw new SignerSignatureError(
      "The signature names a different certificate from the one that made it.",
    );
  }
}

/**
 * Whether a timestamp token is a signature timestamp for this signature
 * value: its TSTInfo's message imprint is the hash of the value, its signed
 * attributes hold the hash of that TSTInfo, and the time-stamping authority's
 * signature over them verifies with the certificate the token carries.
 */
function isTimestampFor(
  bytes: Buffer,
  token: Tlv,
  signatureValue: Buffer,
): boolean {
  try {
    const info = readSignerInfo(elementBytes(bytes, token), "timestamp");
    const tstInfo = info.content!;
    // TSTInfo { version, policy, messageImprint, ... }
    const imprint = children(tstInfo, children(tstInfo, readTlv(tstInfo))[2]!);
    const imprintHash =
      HASHES[readOid(tstInfo, children(tstInfo, imprint[0]!)[0]!)];
    const digestHash = HASHES[info.digestAlgorithm];
    const contentType = info.signedAttributeValues.get(CMS_OIDS.contentType);
    const messageDigest = info.signedAttributeValues.get(
      CMS_OIDS.messageDigest,
    );

    if (
      !imprintHash ||
      !digestHash ||
      !contentBytes(tstInfo, imprint[1]!).equals(
        createHash(imprintHash).update(signatureValue).digest(),
      ) ||
      contentType?.length !== 1 ||
      readOid(info.bytes, contentType[0]!) !== CMS_OIDS.tstInfo ||
      messageDigest?.length !== 1 ||
      !contentBytes(info.bytes, messageDigest[0]!).equals(
        createHash(digestHash).update(tstInfo).digest(),
      )
    ) {
      return false;
    }

    const authority = findSigner(
      info,
      info.certificates.map((certificate) => parseCertificate(certificate)),
    );

    return verifyValue(info, authority.x509.publicKey);
  } catch {
    return false;
  }
}

/** Whether the CMS carries a signature timestamp that checks out. */
function hasSignatureTimestamp(info: ParsedSignerInfo): boolean {
  const tokens =
    info.unsignedAttributeValues.get(CMS_OIDS.timeStampToken) ?? [];

  return tokens.some((token) =>
    isTimestampFor(info.bytes, token, info.signature),
  );
}

export type SignatureLevel = "advanced" | "qualified";

export type CheckedSignerSignature = {
  certificate: Certificate;
  /** The certificates the CMS carries, the signer's first. */
  chain: Buffer[];
  issuer: string;
  /** The certificate says it is qualified, for signatures, on a QSCD. */
  qualified: boolean;
  serialNumber: string;
  subject: string;
  /**
   * The CMS carries a signature timestamp (PAdES B-T) for this signature,
   * signed by the time-stamping authority whose certificate it includes.
   */
  timestamped: boolean;
  validTo: Date;
};

function displayName(distinguishedName: string): string {
  return distinguishedName.replace(/\n/g, ", ");
}

/** Whether a certificate claims to be qualified for electronic signatures. */
export function isQualifiedSignatureCertificate(
  certificate: Certificate,
): boolean {
  return (
    certificate.qcStatements.includes(CMS_OIDS.qcCompliance) &&
    certificate.qcStatements.includes(CMS_OIDS.qcSscd) &&
    (certificate.qcTypes.length === 0 ||
      certificate.qcTypes.includes(CMS_OIDS.qcTypeSignature))
  );
}

const NAME_OIDS = {
  commonName: "2.5.4.3",
  givenName: "2.5.4.42",
  surname: "2.5.4.4",
} as const;

/** A DirectoryString's text, or null for a kind not read here. */
function readDirectoryString(bytes: Buffer, tlv: Tlv): string | null {
  const content = contentBytes(bytes, tlv);

  switch (tlv.tag) {
    case 0x0c: // UTF8String
      return content.toString("utf8");
    case 0x13: // PrintableString
    case 0x14: // TeletexString, read as Latin-1
    case 0x16: // IA5String
      return content.toString("latin1");
    case 0x1e: // BMPString, UTF-16 big-endian
      return Buffer.from(content).swap16().toString("utf16le");
    default:
      return null;
  }
}

/**
 * The names a certificate gives its holder: the given name and surname
 * together, when it has both, and its common name.
 */
export function certificateHolderNames(certificate: Certificate): string[] {
  const bytes = certificate.subjectName;
  const values = new Map<string, string[]>();

  for (const set of children(bytes, readTlv(bytes))) {
    for (const item of children(bytes, set)) {
      const [type, value] = children(bytes, item);
      const text = value ? readDirectoryString(bytes, value) : null;

      if (type && text) {
        const oid = readOid(bytes, type);

        values.set(oid, [...(values.get(oid) ?? []), text]);
      }
    }
  }

  const given = values.get(NAME_OIDS.givenName)?.join(" ");
  const surname = values.get(NAME_OIDS.surname)?.join(" ");

  return [
    ...(given && surname ? [`${given} ${surname}`] : []),
    ...(values.get(NAME_OIDS.commonName) ?? []),
  ];
}

/**
 * A name's words, without case, accents, punctuation or numbers. An
 * apostrophe joins the letters around it, so O'Connor and OConnor are the
 * same word; other punctuation, such as a hyphen, separates words.
 */
function nameWords(name: string): Set<string> {
  return new Set(
    name
      .replace(/['`\u00B4\u2018\u2019\u02BC]/gu, "")
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLocaleLowerCase("en")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0 && !/\p{N}/u.test(word)),
  );
}

/**
 * Whether a certificate is in the name a signer was sent the document
 * under. Case, accents, punctuation and word order do not count, nor do
 * numbers (some national certificates put the holder's ID code in the
 * common name). A name may have words the other lacks, such as a middle
 * name or a title, as long as at least two words match and every word of
 * the shorter name is in the longer; a one-word name has to match exactly.
 */
export function certificateMatchesName(
  certificate: Certificate,
  invitedName: string,
): boolean {
  const invited = nameWords(invitedName);

  return certificateHolderNames(certificate).some((name) => {
    const words = nameWords(name);
    const [shorter, longer] =
      words.size <= invited.size ? [words, invited] : [invited, words];

    return (
      shorter.size > 0 &&
      [...shorter].every((word) => longer.has(word)) &&
      (shorter.size >= 2 || words.size === invited.size)
    );
  });
}

/**
 * Checks a signer's CMS before it goes into the document: it signs exactly
 * `contentDigest` (SHA-256 of the revision's signed bytes), it verifies with
 * the certificate it names, that certificate is valid now, and, for a
 * qualified signature, the certificate says it is one.
 */
export function checkSignerSignature(
  cms: Uint8Array,
  contentDigest: Uint8Array,
  { level, now = new Date() }: { level: SignatureLevel; now?: Date },
): CheckedSignerSignature {
  let info: ParsedSignerInfo;

  try {
    info = readSignerInfo(Buffer.from(cms));
  } catch (error) {
    if (error instanceof SignerSignatureError) {
      throw error;
    }

    throw new SignerSignatureError("The signature could not be read.", {
      cause: error,
    });
  }

  if (info.digestAlgorithm !== CMS_OIDS.sha256) {
    throw new SignerSignatureError("The signature does not use SHA-256.");
  }

  const contentType = info.signedAttributeValues.get(CMS_OIDS.contentType);
  const messageDigest = info.signedAttributeValues.get(CMS_OIDS.messageDigest);

  if (
    contentType?.length !== 1 ||
    readOid(info.bytes, contentType[0]!) !== CMS_OIDS.data
  ) {
    throw new SignerSignatureError("The signature's content type is wrong.");
  }

  if (
    messageDigest?.length !== 1 ||
    !contentBytes(info.bytes, messageDigest[0]!).equals(
      Buffer.from(contentDigest),
    )
  ) {
    throw new SignerSignatureError(
      "The signature is for different content than this document.",
    );
  }

  const certificates = info.certificates.map((certificate) =>
    parseCertificate(certificate),
  );
  const signer = findSigner(info, certificates);
  let verified: boolean;

  try {
    verified = verifyValue(info, signer.x509.publicKey);
  } catch (error) {
    if (error instanceof SignerSignatureError) {
      throw error;
    }

    verified = false;
  }

  if (!verified) {
    throw new SignerSignatureError("The signature does not verify.");
  }

  assertSigningCertificate(info, signer);

  const validFrom = new Date(signer.x509.validFrom);
  const validTo = new Date(signer.x509.validTo);

  if (now < validFrom || now > validTo) {
    throw new SignerSignatureError("The signing certificate is not valid now.");
  }

  const qualified = isQualifiedSignatureCertificate(signer);

  if (level === "qualified" && !qualified) {
    throw new SignerSignatureError(
      "The certificate is not a qualified certificate for electronic signatures on a qualified device.",
    );
  }

  return {
    certificate: signer,
    chain: [
      signer.der,
      ...certificates
        .filter((certificate) => certificate !== signer)
        .map((certificate) => certificate.der),
    ],
    issuer: displayName(signer.x509.issuer),
    qualified,
    serialNumber: signer.serial.toString("hex"),
    subject: displayName(signer.x509.subject),
    timestamped: hasSignatureTimestamp(info),
    validTo,
  };
}

// --- Changing --------------------------------------------------------------

/**
 * Adds a signature timestamp (PAdES B-T) to a CMS without one that checks
 * out: the timestamp token for the SHA-256 of the signature value, as an
 * unsigned attribute. A timestamp attribute that does not check out (empty,
 * for another signature, or not verifying) is replaced. The signature itself
 * is unchanged.
 */
export async function addSignatureTimestamp(
  cms: Uint8Array,
  timestamp: (imprint: Buffer) => Promise<Buffer>,
): Promise<Buffer> {
  const bytes = Buffer.from(cms);
  const info = readSignerInfo(bytes);

  if (hasSignatureTimestamp(info)) {
    return bytes;
  }

  const token = await timestamp(
    createHash("sha256").update(info.signature).digest(),
  );
  const { parts } = readSignedData(bytes);
  const signerInfos = parts[parts.length - 1]!;
  const signerInfo = children(bytes, signerInfos)[0]!;
  const fields = children(bytes, signerInfo);
  const unsigned = fields.find((field) => field.tag === contextTag(1));
  const kept = fields
    .filter((field) => field !== unsigned)
    .map((field) => elementBytes(bytes, field));
  const attributes = [
    ...(unsigned
      ? children(bytes, unsigned)
          .filter(
            (item) =>
              readOid(bytes, children(bytes, item)[0]!) !==
              CMS_OIDS.timeStampToken,
          )
          .map((item) => elementBytes(bytes, item))
      : []),
    attribute(CMS_OIDS.timeStampToken, token),
  ];
  const newSignerInfo = der.sequence(
    ...kept,
    encode(contextTag(1), ...attributes),
  );
  const signedData = der.sequence(
    ...parts.slice(0, -1).map((part) => elementBytes(bytes, part)),
    der.set(newSignerInfo),
  );

  return der.sequence(
    der.oid(CMS_OIDS.signedData),
    encode(contextTag(0), signedData),
  );
}
