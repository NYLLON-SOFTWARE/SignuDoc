import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import forge from "node-forge";

import {
  algorithm,
  children,
  contentBytes,
  der,
  elementBytes,
  encode,
  encodeSmallInteger,
  readTlv,
  TAG,
} from "./der.ts";
import { parseCertificate } from "./pdf-ltv.ts";
import type { SealIdentity } from "./pdf-seal.ts";

// A certificate authority for tests, served over HTTP on this machine: its
// own certificate (for authority information access), an OCSP responder, a
// revocation list and an RFC 3161 time-stamping service whose tokens are
// signed for real, so a PDF reader can check every signature it makes.
//
// Only for tests. Nothing here is careful about anything but shape.

const OID = {
  caIssuers: "1.3.6.1.5.5.7.48.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  ocsp: "1.3.6.1.5.5.7.48.1",
  ocspBasic: "1.3.6.1.5.5.7.48.1.1",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  signedData: "1.2.840.113549.1.7.2",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
} as const;

type KeyPair = { privateKeyPem: string; publicKeyPem: string };

function makeKeys(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

function uri(url: string): Buffer {
  return encode(0x86, Buffer.from(url, "latin1"));
}

function binary(value: Buffer): string {
  return value.toString("binary");
}

function generalizedTime(date: Date): Buffer {
  const text = date
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d+Z$/, "Z");

  return encode(TAG.generalizedTime, Buffer.from(text, "latin1"));
}

function utcTime(date: Date): Buffer {
  const text = date
    .toISOString()
    .slice(2)
    .replace(/[-:T]/g, "")
    .replace(/\.\d+Z$/, "Z");

  return encode(TAG.utcTime, Buffer.from(text, "latin1"));
}

function signSha256(data: Buffer, keys: KeyPair): Buffer {
  return sign("sha256", data, createPrivateKey(keys.privateKeyPem));
}

function bitString(value: Buffer): Buffer {
  return encode(TAG.bitString, Buffer.from([0]), value);
}

/** DER SET OF: the elements sorted by their encoding. */
function sortedSet(items: Buffer[]): Buffer {
  return der.set(...[...items].sort(Buffer.compare));
}

function issueCertificate({
  ca = false,
  commonName,
  extensions = [],
  issuer,
  keys,
  serial,
}: {
  ca?: boolean;
  commonName: string;
  extensions?: object[];
  issuer: { certificate: forge.pki.Certificate | null; keys: KeyPair };
  keys: KeyPair;
  serial: string;
}): forge.pki.Certificate {
  const certificate = forge.pki.createCertificate();
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const subject = [
    { name: "commonName", value: commonName },
    { name: "organizationName", value: "Harbour & Finch Test CA" },
  ];

  certificate.serialNumber = serial;
  certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKeyPem);
  certificate.validity.notBefore = notBefore;
  certificate.validity.notAfter = notAfter;
  certificate.setSubject(subject);
  certificate.setIssuer(
    issuer.certificate ? issuer.certificate.subject.attributes : subject,
  );
  certificate.setExtensions([
    { cA: ca, critical: true, name: "basicConstraints" },
    ca
      ? { critical: true, cRLSign: true, keyCertSign: true, name: "keyUsage" }
      : {
          critical: true,
          digitalSignature: true,
          name: "keyUsage",
          nonRepudiation: true,
        },
    { name: "subjectKeyIdentifier" },
    ...extensions,
  ]);
  certificate.sign(
    forge.pki.privateKeyFromPem(issuer.keys.privateKeyPem),
    forge.md.sha256.create(),
  );

  return certificate;
}

function certificateDer(certificate: forge.pki.Certificate): Buffer {
  return Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
    "binary",
  );
}

export type TestPki = {
  close: () => Promise<void>;
  /** The CA certificate, DER. */
  caCertificate: Buffer;
  /**
   * A person's signing certificate from the CA, as a signing provider would
   * hold it; `qualified` adds the qualified certificate statements.
   */
  issueSigner: (options: {
    commonName: string;
    qualified?: boolean;
  }) => SealIdentity & { certificate: Buffer };
  /** A seal identity issued by the CA, its chain holding only itself. */
  seal: SealIdentity;
  sealCertificate: Buffer;
  /** Switches and counters for the services. */
  state: {
    caFetches: number;
    crlFetches: number;
    /** Extensions put in the revocation list, each an Extension, DER. */
    crlExtensions: Buffer[];
    ocspDown: boolean;
    ocspRequests: number;
    /**
     * Who signs OCSP answers: the CA, a responder the CA authorized for it,
     * or another certificate from the CA that is not allowed to.
     */
    ocspSigner: "ca" | "delegated" | "unauthorized";
    /** Serial numbers (hex, lowercase) the CA says are revoked. */
    revoked: Set<string>;
    /** How long ago the revocation answers say they were made. */
    staleByMs: number;
    /** False: OCSP answers come without a next update. */
    ocspNextUpdate: boolean;
    timestampRequests: number;
  };
  timestampUrl: string;
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

export async function startTestPki(): Promise<TestPki> {
  let handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void> = async (_request, response) => {
    response.writeHead(503).end();
  };
  const server = createServer((request, response) => {
    handler(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  const base = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`;
  const caKeys = makeKeys();
  const ca = issueCertificate({
    ca: true,
    commonName: "Test Root CA",
    issuer: { certificate: null, keys: caKeys },
    keys: caKeys,
    serial: "01",
  });
  const caDer = certificateDer(ca);
  const caParsed = parseCertificate(caDer);
  const infoAccess = {
    id: "1.3.6.1.5.5.7.1.1",
    value: binary(
      der.sequence(
        der.sequence(der.oid(OID.ocsp), uri(`${base}/ocsp`)),
        der.sequence(der.oid(OID.caIssuers), uri(`${base}/ca.cer`)),
      ),
    ),
  };
  const crlPoints = {
    id: "2.5.29.31",
    value: binary(
      der.sequence(
        der.sequence(encode(0xa0, encode(0xa0, uri(`${base}/ca.crl`)))),
      ),
    ),
  };
  const sealKeys = makeKeys();
  const sealCertificate = issueCertificate({
    commonName: "Harbour & Finch document seal",
    extensions: [infoAccess, crlPoints],
    issuer: { certificate: ca, keys: caKeys },
    keys: sealKeys,
    serial: "1001",
  });
  const sealDer = certificateDer(sealCertificate);
  const tsaKeys = makeKeys();
  const tsaCertificate = issueCertificate({
    commonName: "Test Time-Stamping Authority",
    extensions: [
      { critical: true, name: "extKeyUsage", timeStamping: true },
      infoAccess,
      crlPoints,
    ],
    issuer: { certificate: ca, keys: caKeys },
    keys: tsaKeys,
    serial: "2001",
  });
  const tsaDer = certificateDer(tsaCertificate);
  const tsaParsed = parseCertificate(tsaDer);
  const responderKeys = makeKeys();
  const responderDer = certificateDer(
    issueCertificate({
      commonName: "Test OCSP Responder",
      extensions: [
        // Extended key usage: OCSP signing, which forge has no name for.
        {
          id: "2.5.29.37",
          value: binary(der.sequence(der.oid("1.3.6.1.5.5.7.3.9"))),
        },
        // id-pkix-ocsp-nocheck: no revocation check for the responder.
        { id: "1.3.6.1.5.5.7.48.1.5", value: binary(der.null()) },
      ],
      issuer: { certificate: ca, keys: caKeys },
      keys: responderKeys,
      serial: "3001",
    }),
  );
  const strangerKeys = makeKeys();
  const strangerDer = certificateDer(
    issueCertificate({
      commonName: "Another subscriber",
      issuer: { certificate: ca, keys: caKeys },
      keys: strangerKeys,
      serial: "3002",
    }),
  );
  const state: TestPki["state"] = {
    caFetches: 0,
    crlExtensions: [],
    crlFetches: 0,
    ocspDown: false,
    ocspRequests: 0,
    ocspSigner: "ca",
    revoked: new Set(),
    staleByMs: 0,
    ocspNextUpdate: true,
    timestampRequests: 0,
  };
  let tokenSerial = 1;

  function ocspAnswer(requestBody: Buffer): Buffer {
    // OCSPRequest > TBSRequest > requestList > Request > CertID
    let node = readTlv(requestBody);

    for (let depth = 0; depth < 4; depth += 1) {
      node = children(requestBody, node)[0]!;
    }

    const certId = elementBytes(requestBody, node);
    const serial = contentBytes(requestBody, children(requestBody, node)[3]!);
    const now = new Date(Date.now() - state.staleByMs);
    const revoked = state.revoked.has(
      serial.toString("hex").replace(/^0+/, ""),
    );
    const single = der.sequence(
      certId,
      revoked ? encode(0xa1, generalizedTime(now)) : encode(0x80),
      generalizedTime(now),
      ...(state.ocspNextUpdate
        ? [
            encode(
              0xa0,
              generalizedTime(new Date(now.getTime() + 60 * 60 * 1000)),
            ),
          ]
        : []),
    );
    const signer =
      state.ocspSigner === "delegated"
        ? { der: responderDer, keys: responderKeys }
        : state.ocspSigner === "unauthorized"
          ? { der: strangerDer, keys: strangerKeys }
          : null;
    const responseData = der.sequence(
      encode(
        0xa1,
        signer
          ? parseCertificate(signer.der).subjectName
          : caParsed.subjectName,
      ),
      generalizedTime(now),
      der.sequence(single),
    );
    const basic = der.sequence(
      responseData,
      algorithm(OID.sha256WithRsa),
      bitString(signSha256(responseData, signer?.keys ?? caKeys)),
      ...(signer ? [encode(0xa0, der.sequence(signer.der))] : []),
    );

    return der.sequence(
      encode(TAG.enumerated, Buffer.from([0])),
      encode(0xa0, der.sequence(der.oid(OID.ocspBasic), der.octets(basic))),
    );
  }

  function revocationList(): Buffer {
    const now = new Date(Date.now() - state.staleByMs);
    const entries = [...state.revoked].map((serial) =>
      der.sequence(
        encode(
          TAG.integer,
          Buffer.from(serial.length % 2 ? `0${serial}` : serial, "hex"),
        ),
        utcTime(now),
      ),
    );
    const tbs = der.sequence(
      encodeSmallInteger(1),
      algorithm(OID.sha256WithRsa),
      caParsed.subjectName,
      utcTime(now),
      utcTime(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
      ...(entries.length > 0 ? [der.sequence(...entries)] : []),
      ...(state.crlExtensions.length > 0
        ? [encode(0xa0, der.sequence(...state.crlExtensions))]
        : []),
    );

    return der.sequence(
      tbs,
      algorithm(OID.sha256WithRsa),
      bitString(signSha256(tbs, caKeys)),
    );
  }

  function timestampAnswer(requestBody: Buffer): Buffer {
    // TimeStampReq { version, messageImprint, nonce, certReq }
    const fields = children(requestBody, readTlv(requestBody));
    const messageImprint = elementBytes(requestBody, fields[1]!);
    const nonce = fields.slice(2).find((field) => field.tag === TAG.integer);
    const tstInfo = der.sequence(
      encodeSmallInteger(1),
      der.oid("1.2.3.4.1"),
      messageImprint,
      encodeSmallInteger(tokenSerial++),
      generalizedTime(new Date()),
      ...(nonce ? [elementBytes(requestBody, nonce)] : []),
    );
    const attributes = [
      der.sequence(der.oid(OID.contentType), der.set(der.oid(OID.tstInfo))),
      der.sequence(
        der.oid(OID.messageDigest),
        der.set(der.octets(createHash("sha256").update(tstInfo).digest())),
      ),
      der.sequence(
        der.oid(OID.signingCertificateV2),
        der.set(
          der.sequence(
            der.sequence(
              der.sequence(
                der.octets(createHash("sha256").update(tsaDer).digest()),
              ),
            ),
          ),
        ),
      ),
    ].sort(Buffer.compare);
    const signerInfo = der.sequence(
      encodeSmallInteger(1),
      der.sequence(tsaParsed.issuerName, encode(TAG.integer, tsaParsed.serial)),
      algorithm(OID.sha256),
      encode(0xa0, ...attributes),
      algorithm(OID.sha256WithRsa),
      der.octets(signSha256(sortedSet(attributes), tsaKeys)),
    );
    const signedData = der.sequence(
      encodeSmallInteger(3),
      der.set(algorithm(OID.sha256)),
      der.sequence(der.oid(OID.tstInfo), encode(0xa0, der.octets(tstInfo))),
      encode(0xa0, tsaDer, caDer),
      der.set(signerInfo),
    );
    const token = der.sequence(
      der.oid(OID.signedData),
      encode(0xa0, signedData),
    );

    return der.sequence(der.sequence(encodeSmallInteger(0)), token);
  }

  handler = async (request, response) => {
    const body = await readBody(request);

    if (request.url === "/ca.cer") {
      state.caFetches += 1;
      response
        .writeHead(200, { "content-type": "application/pkix-cert" })
        .end(caDer);
    } else if (request.url === "/ca.crl") {
      state.crlFetches += 1;
      response
        .writeHead(200, { "content-type": "application/pkix-crl" })
        .end(revocationList());
    } else if (request.url === "/ocsp") {
      state.ocspRequests += 1;

      if (state.ocspDown) {
        response.writeHead(503).end();
      } else {
        response
          .writeHead(200, { "content-type": "application/ocsp-response" })
          .end(ocspAnswer(body));
      }
    } else if (request.url === "/tsa") {
      state.timestampRequests += 1;
      response
        .writeHead(200, { "content-type": "application/timestamp-reply" })
        .end(timestampAnswer(body));
    } else {
      response.writeHead(404).end();
    }
  };

  let signerSerial = 0x4000;
  const issueSigner: TestPki["issueSigner"] = ({ commonName, qualified }) => {
    const keys = makeKeys();
    // QCStatements: QcCompliance, QcSSCD, QcType esign (ETSI EN 319 412-5).
    const qcStatements = {
      id: "1.3.6.1.5.5.7.1.3",
      value: binary(
        der.sequence(
          der.sequence(der.oid("0.4.0.1862.1.1")),
          der.sequence(der.oid("0.4.0.1862.1.4")),
          der.sequence(
            der.oid("0.4.0.1862.1.6"),
            der.sequence(der.oid("0.4.0.1862.1.6.1")),
          ),
        ),
      ),
    };

    signerSerial += 1;

    const certificate = issueCertificate({
      commonName,
      extensions: [infoAccess, crlPoints, ...(qualified ? [qcStatements] : [])],
      issuer: { certificate: ca, keys: caKeys },
      keys,
      serial: signerSerial.toString(16),
    });

    return {
      certificate: certificateDer(certificate),
      certificateChainPem: [
        forge.pki.certificateToPem(certificate),
        forge.pki.certificateToPem(ca),
      ],
      privateKeyPem: keys.privateKeyPem,
    };
  };

  return {
    caCertificate: caDer,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    issueSigner,
    seal: {
      certificateChainPem: [forge.pki.certificateToPem(sealCertificate)],
      privateKeyPem: sealKeys.privateKeyPem,
    },
    sealCertificate: sealDer,
    state,
    timestampUrl: `${base}/tsa`,
  };
}
