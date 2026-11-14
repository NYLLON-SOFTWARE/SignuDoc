import {
  createHash,
  verify as verifySignature,
  X509Certificate,
} from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import {
  algorithm,
  children,
  contentBytes,
  contextTag,
  der,
  elementBytes,
  encode,
  expectTag,
  readOid,
  readTime,
  readTlv,
  TAG,
  type Tlv,
} from "./der.ts";
import {
  appendDocumentSecurityStore,
  appendDocumentTimestamp,
  findSignatures,
  hasDocumentSecurityStore,
} from "./pdf-incremental.ts";

// Long-term validation (PAdES B-LT and B-LTA, ETSI EN 319 142-1).
//
// A seal made today verifies today, while its certificates are valid and
// their issuers still answer revocation checks. Years later they may not.
// So after sealing, the certificates of the seal and of its timestamp, and
// a fresh answer that none of them is revoked (an OCSP response, or a
// revocation list), go into the PDF's document security store (B-LT). Then
// a document timestamp seals all of that in (B-LTA), so a reader can show
// the evidence existed at that time, even after the certificates expire.
//
// The certificates come from the signatures themselves; a missing issuer is
// fetched from the address its certificate names (authority information
// access), and revocation answers from the OCSP responder or revocation list
// the certificate names. Those are the certificate authority's own services,
// outside this install.

const OIDS = {
  caIssuers: "1.3.6.1.5.5.7.48.2",
  crlDistributionPoints: "2.5.29.31",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4",
  infoAccess: "1.3.6.1.5.5.7.1.1",
  ocsp: "1.3.6.1.5.5.7.48.1",
  ocspBasic: "1.3.6.1.5.5.7.48.1.1",
  ocspNoCheck: "1.3.6.1.5.5.7.48.1.5",
  sha1: "1.3.14.3.2.26",
  sha1WithRsa: "1.2.840.113549.1.1.5",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  sha384WithRsa: "1.2.840.113549.1.1.12",
  sha512WithRsa: "1.2.840.113549.1.1.13",
  signedData: "1.2.840.113549.1.7.2",
  timeStampToken: "1.2.840.113549.1.9.16.2.14",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
} as const;

const SIGNATURE_HASHES: Record<string, string> = {
  [OIDS.ecdsaSha256]: "sha256",
  [OIDS.ecdsaSha384]: "sha384",
  [OIDS.ecdsaSha512]: "sha512",
  [OIDS.sha1WithRsa]: "sha1",
  [OIDS.sha256WithRsa]: "sha256",
  [OIDS.sha384WithRsa]: "sha384",
  [OIDS.sha512WithRsa]: "sha512",
};

const MAX_CHAIN_CERTIFICATES = 16;
const MAX_FETCHES = 24;
/** All the lookups for one document, together. */
const LOOKUP_BUDGET_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const ISSUER_CACHE_MS = 24 * 60 * 60 * 1000;
const REVOCATION_CACHE_MS = 10 * 60 * 1000;
/** How far another clock may be ahead of this one. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The oldest an answer without a next update may be. */
const OCSP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CRL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OCSP_SIGNING = "1.3.6.1.5.5.7.3.9";

export class LongTermValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LongTermValidationError";
  }
}

// --- Certificates --------------------------------------------------------

export type Certificate = {
  caIssuerUrls: string[];
  crlUrls: string[];
  der: Buffer;
  fingerprint: string;
  /** The issuer Name, as encoded. */
  issuerName: Buffer;
  ocspNoCheck: boolean;
  ocspUrls: string[];
  /** The serial number's INTEGER content, as OCSP and CRLs compare it. */
  serial: Buffer;
  /** The subject public key, without the BIT STRING's unused-bits byte. */
  subjectKey: Buffer;
  /** The subject Name, as encoded. */
  subjectName: Buffer;
  x509: X509Certificate;
};

function uriNames(bytes: Uint8Array, tlv: Tlv, into: string[]) {
  // GeneralName uniformResourceIdentifier is [6] IA5String.
  if (tlv.tag === 0x86) {
    into.push(contentBytes(bytes, tlv).toString("latin1"));
    return;
  }

  if (tlv.tag & 0x20) {
    for (const child of children(bytes, tlv)) {
      uriNames(bytes, child, into);
    }
  }
}

function httpUrls(urls: string[]): string[] {
  return urls.filter((url) => /^https?:\/\//i.test(url));
}

export function parseCertificate(input: Uint8Array): Certificate {
  const bytes = Buffer.from(input);
  const certificate = readTlv(bytes);
  const tbs = expectTag(
    children(bytes, certificate)[0],
    TAG.sequence,
    "a certificate",
  );
  const fields = children(bytes, tbs);
  const offset = fields[0]?.tag === contextTag(0) ? 1 : 0;
  const serial = expectTag(fields[offset], TAG.integer, "a serial number");
  const issuerName = expectTag(fields[offset + 2], TAG.sequence, "an issuer");
  const subject = expectTag(fields[offset + 4], TAG.sequence, "a subject");
  const spki = expectTag(fields[offset + 5], TAG.sequence, "a public key");
  const key = expectTag(
    children(bytes, spki)[1],
    TAG.bitString,
    "a public key",
  );
  const parsed: Certificate = {
    caIssuerUrls: [],
    crlUrls: [],
    der: elementBytes(bytes, certificate),
    fingerprint: createHash("sha256")
      .update(bytes.subarray(certificate.start, certificate.end))
      .digest("hex"),
    issuerName: elementBytes(bytes, issuerName),
    ocspNoCheck: false,
    ocspUrls: [],
    serial: contentBytes(bytes, serial),
    subjectKey: contentBytes(bytes, key).subarray(1),
    subjectName: elementBytes(bytes, subject),
    x509: new X509Certificate(elementBytes(bytes, certificate)),
  };
  const extensions = fields.find((field) => field.tag === contextTag(3));

  if (extensions) {
    const list = expectTag(
      children(bytes, extensions)[0],
      TAG.sequence,
      "extensions",
    );

    for (const extension of children(bytes, list)) {
      const parts = children(bytes, extension);
      const id = readOid(bytes, parts[0]!);
      const value = parts[parts.length - 1]!;
      const inner = readTlv(bytes, value.contentStart, value.end);

      if (id === OIDS.ocspNoCheck) {
        parsed.ocspNoCheck = true;
      } else if (id === OIDS.crlDistributionPoints) {
        uriNames(bytes, inner, parsed.crlUrls);
      } else if (id === OIDS.infoAccess) {
        for (const description of children(bytes, inner)) {
          const [method, location] = children(bytes, description);
          const urls: string[] = [];

          uriNames(bytes, location!, urls);

          if (readOid(bytes, method!) === OIDS.ocsp) {
            parsed.ocspUrls.push(...urls);
          } else if (readOid(bytes, method!) === OIDS.caIssuers) {
            parsed.caIssuerUrls.push(...urls);
          }
        }
      }
    }
  }

  parsed.caIssuerUrls = httpUrls(parsed.caIssuerUrls);
  parsed.crlUrls = httpUrls(parsed.crlUrls);
  parsed.ocspUrls = httpUrls(parsed.ocspUrls);

  return parsed;
}

/**
 * Whether `issuer` signed `certificate`: its subject is the certificate's
 * issuer, and its key verifies the certificate's signature. (OpenSSL's own
 * issuer check also wants the issuer to be allowed to sign certificates,
 * which a self-made seal certificate is not.)
 */
function isIssuedBy(certificate: Certificate, issuer: Certificate): boolean {
  try {
    return (
      certificate.issuerName.equals(issuer.subjectName) &&
      certificate.x509.verify(issuer.x509.publicKey)
    );
  } catch {
    return false;
  }
}

export function isSelfSigned(certificate: Certificate): boolean {
  return isIssuedBy(certificate, certificate);
}

/** Certificates from a DER or PEM certificate, or a certs-only PKCS#7. */
export function certificatesFromBundle(body: Uint8Array): Certificate[] {
  const text = Buffer.from(body).toString("latin1");

  if (text.includes("-----BEGIN CERTIFICATE-----")) {
    return [
      ...text.matchAll(
        /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g,
      ),
    ].map((match) =>
      parseCertificate(Buffer.from(match[1]!.replace(/\s+/g, ""), "base64")),
    );
  }

  try {
    return [parseCertificate(body)];
  } catch {
    return readCms(body).certificates.map(parseCertificate);
  }
}

// --- CMS -----------------------------------------------------------------

type CmsContents = {
  certificates: Buffer[];
  /** Timestamp tokens in the signer infos' unsigned attributes. */
  timestampTokens: Buffer[];
};

/** The certificates and timestamp tokens of a CMS SignedData. */
export function readCms(input: Uint8Array): CmsContents {
  const bytes = Buffer.from(input);
  const contentInfo = readTlv(bytes);
  const [type, wrapped] = children(bytes, contentInfo);

  if (readOid(bytes, type!) !== OIDS.signedData) {
    throw new LongTermValidationError("Not a CMS SignedData.");
  }

  const signedData = children(bytes, wrapped!)[0]!;
  const parts = children(bytes, signedData);
  const result: CmsContents = { certificates: [], timestampTokens: [] };

  for (const part of parts) {
    if (part.tag === contextTag(0)) {
      for (const certificate of children(bytes, part)) {
        if (certificate.tag === TAG.sequence) {
          result.certificates.push(elementBytes(bytes, certificate));
        }
      }
    }
  }

  const signerInfos = parts[parts.length - 1]!;

  for (const signerInfo of children(bytes, signerInfos)) {
    const unsigned = children(bytes, signerInfo).find(
      (field) => field.tag === contextTag(1),
    );

    for (const attribute of unsigned ? children(bytes, unsigned) : []) {
      const [id, values] = children(bytes, attribute);

      if (readOid(bytes, id!) === OIDS.timeStampToken) {
        for (const token of children(bytes, values!)) {
          result.timestampTokens.push(elementBytes(bytes, token));
        }
      }
    }
  }

  return result;
}

/** Every certificate in a CMS and in the timestamp tokens inside it. */
function cmsCertificates(cms: Uint8Array, depth = 0): Buffer[] {
  const contents = readCms(cms);

  return [
    ...contents.certificates,
    ...(depth < 3
      ? contents.timestampTokens.flatMap((token) =>
          cmsCertificates(token, depth + 1),
        )
      : []),
  ];
}

// --- Fetching --------------------------------------------------------------

export type ValidationFetch = (
  url: string,
  request?: { body: Buffer; contentType: string },
) => Promise<Buffer>;

function isPrivateAddress(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase();

  if (address === "localhost" || address.endsWith(".localhost")) {
    return true;
  }

  const version = isIP(address);

  if (version === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      // Multicast, reserved and broadcast.
      a >= 224
    );
  }

  if (version === 6) {
    // An IPv4 address mapped into IPv6, which URL writes in hex.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
    const mapped = hex
      ? [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)]
          .flatMap((word) => [word >> 8, word & 0xff])
          .join(".")
      : /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];

    return (
      address === "::" ||
      address === "::1" ||
      /^f[cd]/.test(address) ||
      /^fe[89ab]/.test(address) ||
      /^ff/.test(address) ||
      (mapped ? isPrivateAddress(mapped) : false)
    );
  }

  return false;
}

type AddressLookup = (
  hostname: string,
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void;

const systemLookup: AddressLookup = (hostname, callback) => {
  dnsLookup(hostname, { all: true }, (error, addresses) =>
    callback(error, addresses ?? []),
  );
};

/**
 * Resolves a host for a connection, refusing it when any of its addresses is
 * private. The connection is made to the address checked here, so a name
 * cannot resolve to a public address for the check and a private one after.
 */
function guardedLookup(
  resolve: AddressLookup,
  allowPrivateAddresses: boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (error, found) => {
      const family = options.family === 6 ? 6 : options.family === 4 ? 4 : 0;
      const addresses = found.filter(
        (address) => family === 0 || address.family === family,
      );

      if (error || addresses.length === 0) {
        callback(
          error ??
            new LongTermValidationError(`${hostname} has no address to use.`),
          "",
        );
        return;
      }

      const blocked = addresses.find((address) =>
        isPrivateAddress(address.address),
      );

      if (blocked && !allowPrivateAddresses) {
        callback(
          new LongTermValidationError(
            `Refused to fetch from a private address (${hostname} is ${blocked.address}).`,
          ),
          "",
        );
        return;
      }

      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    });
  };
}

type FetchedResponse = {
  body: Buffer;
  location: string | null;
  status: number;
};

function fetchOnce(
  target: URL,
  request: { body: Buffer; contentType: string } | undefined,
  {
    lookup,
    maxBytes,
    timeoutMs,
  }: { lookup: LookupFunction; maxBytes: number; timeoutMs: number },
): Promise<FetchedResponse> {
  return new Promise((resolve, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(
      target,
      {
        // A fresh connection each time, so each one goes through the lookup.
        agent: false,
        headers: request
          ? {
              "content-length": String(request.body.length),
              "content-type": request.contentType,
            }
          : {},
        lookup,
        method: request ? "POST" : "GET",
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;

        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ body: Buffer.alloc(0), location, status });
          return;
        }

        const declared = Number(response.headers["content-length"] ?? "0");

        if (declared > maxBytes) {
          response.destroy();
          reject(new LongTermValidationError(`${target.host} sent too much.`));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;

        response.on("data", (chunk: Buffer) => {
          total += chunk.length;

          if (total > maxBytes) {
            response.destroy();
            reject(
              new LongTermValidationError(`${target.host} sent too much.`),
            );
            return;
          }

          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ body: Buffer.concat(chunks), location, status }),
        );
        response.on("error", reject);
      },
    );

    outgoing.on("error", reject);
    outgoing.end(request?.body);
  });
}

/**
 * Fetches from a certificate authority's service. Only http and https, no
 * addresses on this machine or a private network (the addresses come from
 * certificates, so a name is checked for what it resolves to), a few
 * redirects at most, and a size limit.
 */
export function createValidationFetch({
  allowPrivateAddresses = false,
  lookup: resolve = systemLookup,
  maxBytes = MAX_RESPONSE_BYTES,
  timeoutMs = FETCH_TIMEOUT_MS,
}: {
  allowPrivateAddresses?: boolean;
  /** Replaced in tests: resolves a host name to its addresses. */
  lookup?: AddressLookup;
  maxBytes?: number;
  timeoutMs?: number;
} = {}): ValidationFetch {
  const lookup = guardedLookup(resolve, allowPrivateAddresses);

  return async (url, request) => {
    let target = new URL(url);

    for (let hop = 0; hop < 4; hop += 1) {
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new LongTermValidationError(
          `Refused to fetch ${target.protocol} URL.`,
        );
      }

      // An address written as such is connected to without a lookup.
      if (!allowPrivateAddresses && isPrivateAddress(target.hostname)) {
        throw new LongTermValidationError(
          `Refused to fetch from a private address (${target.hostname}).`,
        );
      }

      const response = await fetchOnce(target, request, {
        lookup,
        maxBytes,
        timeoutMs,
      });

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.location
      ) {
        target = new URL(response.location, target);
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new LongTermValidationError(
          `${target.host} answered ${String(response.status)}.`,
        );
      }

      return response.body;
    }

    throw new LongTermValidationError("Too many redirects.");
  };
}

type CacheEntry = { expiresAt: number; value: unknown };

declare global {
  var __signudocValidationCache: Map<string, CacheEntry> | undefined;
}

function cache(): Map<string, CacheEntry> {
  globalThis.__signudocValidationCache ??= new Map();

  return globalThis.__signudocValidationCache;
}

/** Forgets cached issuer certificates and revocation answers, for tests. */
export function resetValidationCache() {
  globalThis.__signudocValidationCache = undefined;
}

async function cached<T>(
  key: string,
  lifetimeMs: (value: T) => number,
  load: () => Promise<T>,
): Promise<T> {
  const store = cache();
  const hit = store.get(key);

  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }

  const value = await load();

  if (store.size > 500) {
    store.clear();
  }

  const lifetime = lifetimeMs(value);

  if (lifetime > 0) {
    store.set(key, { expiresAt: Date.now() + lifetime, value });
  }

  return value;
}

// --- Revocation ------------------------------------------------------------

type RevocationAnswer = {
  data: Buffer;
  /** Certificates the answer came with, such as a delegated OCSP responder. */
  extraCertificates: Buffer[];
  kind: "crl" | "ocsp";
  nextUpdate: Date | null;
  status: "good" | "revoked";
};

function hashName(oid: string): string | null {
  return oid === OIDS.sha1 ? "sha1" : oid === OIDS.sha256 ? "sha256" : null;
}

function verifiesWith(
  hash: string | undefined,
  data: Buffer,
  signer: Certificate,
  signature: Buffer,
): boolean {
  if (!hash) {
    return false;
  }

  try {
    return verifySignature(hash, data, signer.x509.publicKey, signature);
  } catch {
    return false;
  }
}

/** The OCSP request for one certificate (RFC 6960 4.1.1), with SHA-1 IDs. */
export function buildOcspRequest(
  certificate: Certificate,
  issuer: Certificate,
): Buffer {
  const sha1 = (value: Buffer) => createHash("sha1").update(value).digest();
  const certId = der.sequence(
    algorithm(OIDS.sha1),
    der.octets(sha1(issuer.subjectName)),
    der.octets(sha1(issuer.subjectKey)),
    encode(TAG.integer, certificate.serial),
  );

  return der.sequence(der.sequence(der.sequence(der.sequence(certId))));
}

/**
 * Refuses a revocation answer that is not current: issued in the future,
 * past its next update, or, without one, older than `maxAgeMs`. A stale
 * answer could hide a revocation made since.
 */
function assertCurrent(
  thisUpdate: Date,
  nextUpdate: Date | null,
  { maxAgeMs, now, what }: { maxAgeMs: number; now: Date; what: string },
) {
  if (thisUpdate.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    throw new LongTermValidationError(`The ${what} is dated in the future.`);
  }

  if (nextUpdate) {
    if (nextUpdate.getTime() < now.getTime() - CLOCK_SKEW_MS) {
      throw new LongTermValidationError(`The ${what} is out of date.`);
    }
  } else if (thisUpdate.getTime() < now.getTime() - maxAgeMs) {
    throw new LongTermValidationError(`The ${what} is out of date.`);
  }
}

function isValidAt(certificate: Certificate, now: Date): boolean {
  const from = Date.parse(certificate.x509.validFrom);
  const to = Date.parse(certificate.x509.validTo);

  return now.getTime() >= from - CLOCK_SKEW_MS && now.getTime() <= to;
}

/**
 * A responder the issuer delegated OCSP to (RFC 6960 4.2.2.2): certified by
 * the issuer for OCSP signing, and valid now. Any other certificate from
 * the same issuer may not answer for it.
 */
function isAuthorizedResponder(
  responder: Certificate,
  issuer: Certificate,
  now: Date,
): boolean {
  return (
    isIssuedBy(responder, issuer) &&
    (responder.x509.keyUsage ?? []).includes(OCSP_SIGNING) &&
    isValidAt(responder, now)
  );
}

/** Reads an OCSP response for `certificate`, checking it is the issuer's. */
export function readOcspResponse(
  body: Buffer,
  certificate: Certificate,
  issuer: Certificate,
  now = new Date(),
): RevocationAnswer {
  const response = readTlv(body);
  const [status, responseBytes] = children(body, response);

  if (
    contentBytes(body, expectTag(status, TAG.enumerated, "a status"))[0] !== 0
  ) {
    throw new LongTermValidationError(
      "The OCSP responder did not answer successfully.",
    );
  }

  const [type, octets] = children(body, children(body, responseBytes!)[0]!);

  if (readOid(body, type!) !== OIDS.ocspBasic) {
    throw new LongTermValidationError(
      "The OCSP answer is not a basic response.",
    );
  }

  const basicStart = octets!.contentStart;
  const basic = readTlv(body, basicStart, octets!.end);
  const [tbs, signatureAlgorithm, signatureValue, certsField] = children(
    body,
    basic,
  );
  const tbsFields = children(body, tbs!);
  const responses = tbsFields.find(
    (field, index) =>
      index > 0 &&
      field.tag === TAG.sequence &&
      tbsFields[index - 1]!.tag === TAG.generalizedTime,
  );
  let match: {
    nextUpdate: Date | null;
    status: "good" | "revoked";
    thisUpdate: Date;
  } | null = null;

  for (const single of responses ? children(body, responses) : []) {
    const [certId, certStatus, thisUpdate, ...rest] = children(body, single);
    const [hashAlgorithm, nameHash, keyHash, serial] = children(body, certId!);
    const hash = hashName(readOid(body, children(body, hashAlgorithm!)[0]!));

    if (
      !hash ||
      !contentBytes(body, serial!).equals(certificate.serial) ||
      !contentBytes(body, nameHash!).equals(
        createHash(hash).update(issuer.subjectName).digest(),
      ) ||
      !contentBytes(body, keyHash!).equals(
        createHash(hash).update(issuer.subjectKey).digest(),
      )
    ) {
      continue;
    }

    if (certStatus!.tag === 0x82) {
      throw new LongTermValidationError(
        "The OCSP responder does not know the certificate.",
      );
    }

    const next = rest.find((field) => field.tag === contextTag(0));

    match = {
      nextUpdate: next ? readTime(body, children(body, next)[0]!) : null,
      status: certStatus!.tag === 0x80 ? "good" : "revoked",
      thisUpdate: readTime(body, thisUpdate!),
    };
    break;
  }

  if (!match) {
    throw new LongTermValidationError(
      "The OCSP answer is about another certificate.",
    );
  }

  const extraCertificates =
    certsField && certsField.tag === contextTag(0)
      ? children(body, children(body, certsField)[0]!).map((cert) =>
          elementBytes(body, cert),
        )
      : [];
  const hash =
    SIGNATURE_HASHES[readOid(body, children(body, signatureAlgorithm!)[0]!)];
  const signature = contentBytes(body, signatureValue!).subarray(1);
  const signed = elementBytes(body, tbs!);
  // Signed by the issuer itself, or by a responder the issuer authorized.
  const candidates = [
    issuer,
    ...extraCertificates
      .map((cert) => parseCertificate(cert))
      .filter((responder) => isAuthorizedResponder(responder, issuer, now)),
  ];

  if (
    !candidates.some((signer) => verifiesWith(hash, signed, signer, signature))
  ) {
    throw new LongTermValidationError(
      "The OCSP answer's signature does not verify.",
    );
  }

  assertCurrent(match.thisUpdate, match.nextUpdate, {
    maxAgeMs: OCSP_MAX_AGE_MS,
    now,
    what: "OCSP answer",
  });

  return {
    data: elementBytes(body, response),
    extraCertificates,
    kind: "ocsp",
    nextUpdate: match.nextUpdate,
    status: match.status,
  };
}

/** Reads a revocation list from `issuer`, and whether it lists `certificate`. */
export function readCrl(
  body: Buffer,
  certificate: Certificate,
  issuer: Certificate,
  now = new Date(),
): RevocationAnswer {
  const list = readTlv(body);
  const [tbs, signatureAlgorithm, signatureValue] = children(body, list);
  const fields = children(body, tbs!);
  const offset = fields[0]!.tag === TAG.integer ? 1 : 0;
  const issuerName = fields[offset + 1]!;

  if (!elementBytes(body, issuerName).equals(issuer.subjectName)) {
    throw new LongTermValidationError(
      "The revocation list is from another issuer.",
    );
  }

  const hash =
    SIGNATURE_HASHES[readOid(body, children(body, signatureAlgorithm!)[0]!)];

  if (
    !verifiesWith(
      hash,
      elementBytes(body, tbs!),
      issuer,
      contentBytes(body, signatureValue!).subarray(1),
    )
  ) {
    throw new LongTermValidationError(
      "The revocation list's signature does not verify.",
    );
  }

  const thisUpdate = readTime(body, fields[offset + 2]!);
  const rest = fields.slice(offset + 3);
  const nextUpdate =
    rest[0] &&
    (rest[0].tag === TAG.utcTime || rest[0].tag === TAG.generalizedTime)
      ? readTime(body, rest[0])
      : null;

  assertCurrent(thisUpdate, nextUpdate, {
    maxAgeMs: CRL_MAX_AGE_MS,
    now,
    what: "revocation list",
  });
  const revoked = rest.find((field) => field.tag === TAG.sequence);
  const listed = (revoked ? children(body, revoked) : []).some((entry) =>
    contentBytes(body, children(body, entry)[0]!).equals(certificate.serial),
  );

  return {
    data: elementBytes(body, list),
    extraCertificates: [],
    kind: "crl",
    nextUpdate,
    status: listed ? "revoked" : "good",
  };
}

// --- Collecting --------------------------------------------------------------

export type ValidationData = {
  certificates: Buffer[];
  crls: Buffer[];
  ocsps: Buffer[];
  /** What could not be found or checked, for the log. */
  problems: string[];
  /** Subjects of certificates their issuer says are revoked. */
  revoked: string[];
};

function revocationLifetime(answer: RevocationAnswer | null): number {
  // No answer is not kept: the next document asks again.
  if (!answer) {
    return 0;
  }

  if (!answer.nextUpdate) {
    return REVOCATION_CACHE_MS;
  }

  return Math.max(
    0,
    Math.min(REVOCATION_CACHE_MS, answer.nextUpdate.getTime() - Date.now()),
  );
}

/** The time and number of lookups one document may still spend. */
export type LookupBudget = { deadline: number; fetches: number };

export function createLookupBudget(budgetMs = LOOKUP_BUDGET_MS): LookupBudget {
  return { deadline: Date.now() + budgetMs, fetches: 0 };
}

/** Runs `task`, giving up when the document's lookup time runs out. */
async function withinBudget<T>(
  budget: LookupBudget,
  task: () => Promise<T>,
): Promise<T> {
  const remaining = budget.deadline - Date.now();

  if (remaining <= 0) {
    throw new LongTermValidationError("Ran out of time for lookups.");
  }

  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new LongTermValidationError("Ran out of time for lookups.")),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gathers the certificate chains of every signature given (CMS or RFC 3161
 * tokens) up to their roots, with a revocation answer for each certificate
 * that needs one.
 */
export async function collectValidationData(
  signatures: readonly Uint8Array[],
  {
    budget = createLookupBudget(),
    fetch: fetchFrom = createValidationFetch(),
  }: {
    /** Shared by every step of one document. */
    budget?: LookupBudget;
    fetch?: ValidationFetch;
  } = {},
): Promise<ValidationData> {
  const pool = new Map<string, Certificate>();
  const result: ValidationData = {
    certificates: [],
    crls: [],
    ocsps: [],
    problems: [],
    revoked: [],
  };
  // A slow certificate authority must not hold up a signing for long.
  const limitedFetch: ValidationFetch = (url, request) => {
    budget.fetches += 1;

    if (budget.fetches > MAX_FETCHES) {
      throw new LongTermValidationError("Too many lookups for one document.");
    }

    return withinBudget(budget, () => fetchFrom(url, request));
  };
  const addToPool = (certificate: Certificate) => {
    if (!pool.has(certificate.fingerprint)) {
      pool.set(certificate.fingerprint, certificate);
    }

    return pool.get(certificate.fingerprint)!;
  };
  const queue: Certificate[] = [];

  for (const signature of signatures) {
    for (const certificate of cmsCertificates(signature)) {
      queue.push(addToPool(parseCertificate(certificate)));
    }
  }

  const done = new Set<string>();

  while (queue.length > 0 && done.size < MAX_CHAIN_CERTIFICATES) {
    const certificate = queue.shift()!;

    if (done.has(certificate.fingerprint)) {
      continue;
    }

    done.add(certificate.fingerprint);
    result.certificates.push(certificate.der);

    if (isSelfSigned(certificate)) {
      continue;
    }

    const name = certificate.x509.subject.replace(/\n/g, ", ");
    let issuer = [...pool.values()].find((candidate) =>
      isIssuedBy(certificate, candidate),
    );

    for (const url of issuer ? [] : certificate.caIssuerUrls) {
      try {
        const found = await cached(
          `issuer:${url}`,
          () => ISSUER_CACHE_MS,
          async () => certificatesFromBundle(await limitedFetch(url)),
        );

        found.forEach(addToPool);
        issuer = found.find((candidate) => isIssuedBy(certificate, candidate));
      } catch (error) {
        result.problems.push(
          `Could not fetch the issuer of ${name}: ${describe(error)}`,
        );
      }

      if (issuer) {
        break;
      }
    }

    if (!issuer) {
      result.problems.push(`The issuer of ${name} was not found.`);
      continue;
    }

    queue.push(issuer);

    if (certificate.ocspNoCheck) {
      continue;
    }

    const answer = await cached<RevocationAnswer | null>(
      `revocation:${certificate.fingerprint}`,
      revocationLifetime,
      () => fetchRevocation(certificate, issuer, limitedFetch, result.problems),
    );

    if (!answer) {
      result.problems.push(`No revocation information was found for ${name}.`);
      continue;
    }

    (answer.kind === "ocsp" ? result.ocsps : result.crls).push(answer.data);

    for (const extra of answer.extraCertificates) {
      queue.push(addToPool(parseCertificate(extra)));
    }

    if (answer.status === "revoked") {
      result.revoked.push(name);
    }
  }

  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchRevocation(
  certificate: Certificate,
  issuer: Certificate,
  fetchFrom: ValidationFetch,
  problems: string[],
): Promise<RevocationAnswer | null> {
  for (const url of certificate.ocspUrls) {
    try {
      return readOcspResponse(
        await fetchFrom(url, {
          body: buildOcspRequest(certificate, issuer),
          contentType: "application/ocsp-request",
        }),
        certificate,
        issuer,
      );
    } catch (error) {
      problems.push(`OCSP at ${url} failed: ${describe(error)}`);
    }
  }

  for (const url of certificate.crlUrls) {
    try {
      return readCrl(await fetchFrom(url), certificate, issuer);
    } catch (error) {
      problems.push(`The revocation list at ${url} failed: ${describe(error)}`);
    }
  }

  return null;
}

// --- The document ------------------------------------------------------------

export type PadesLevel = "B-B" | "B-T" | "B-LT" | "B-LTA";

/**
 * The PAdES baseline level of the file's first signature: B-T when it has a
 * signature timestamp, B-LT when validation data was added after it, B-LTA
 * when a document timestamp follows that. Null when the file is unsigned.
 */
export async function describePadesLevel(
  bytes: Uint8Array,
): Promise<PadesLevel | null> {
  const signatures = findSignatures(bytes);
  const first = signatures.find(
    (signature) => signature.subFilter !== "ETSI.RFC3161",
  );

  if (!first) {
    return null;
  }

  if (readCms(first.contents).timestampTokens.length === 0) {
    return "B-B";
  }

  if (!(await hasDocumentSecurityStore(bytes))) {
    return "B-T";
  }

  const firstEnd = first.byteRange[2] + first.byteRange[3];
  const archived = signatures.some(
    (signature) =>
      signature.subFilter === "ETSI.RFC3161" &&
      signature.byteRange[2] + signature.byteRange[3] > firstEnd,
  );

  return archived ? "B-LTA" : "B-LT";
}

export type LongTermValidationResult = {
  bytes: Uint8Array;
  problems: string[];
  revoked: string[];
};

/**
 * Adds validation data for every signature in the file and, given a
 * time-stamping function, a document timestamp after it with the timestamp's
 * own validation data. Returns the file as far as it got: a failure in the
 * document timestamp keeps the validation data. All of it, the timestamp
 * included, shares one lookup budget.
 */
export async function addLongTermValidation(
  bytes: Uint8Array,
  {
    budget = createLookupBudget(),
    fetch: fetchFrom = createValidationFetch(),
    timestamp,
  }: {
    budget?: LookupBudget;
    fetch?: ValidationFetch;
    /** Returns an RFC 3161 token for a SHA-256 digest. */
    timestamp?: ((digest: Buffer) => Promise<Buffer>) | null;
  } = {},
): Promise<LongTermValidationResult> {
  const data = await collectValidationData(
    findSignatures(bytes).map((signature) => signature.contents),
    { budget, fetch: fetchFrom },
  );
  const problems = [...data.problems];
  const revoked = [...data.revoked];
  let current = await appendDocumentSecurityStore(bytes, data);

  if (!timestamp) {
    return { bytes: current, problems, revoked };
  }

  try {
    current = await appendDocumentTimestamp(current, (digest) =>
      withinBudget(budget, () => timestamp(digest)),
    );

    const archive = findSignatures(current).at(-1)!;
    const more = await collectValidationData([archive.contents], {
      budget,
      fetch: fetchFrom,
    });

    problems.push(...more.problems);
    revoked.push(...more.revoked);
    current = await appendDocumentSecurityStore(current, more);
  } catch (error) {
    problems.push(`The archive timestamp failed: ${describe(error)}`);
  }

  return { bytes: current, problems, revoked };
}
