import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  StandardFonts,
} from "pdf-lib";

import {
  children,
  contentBytes,
  der,
  encode,
  encodeSmallInteger,
  readOid,
  readTlv,
  TAG,
} from "./der.ts";
import { findSignatures, hasDocumentSecurityStore } from "./pdf-incremental.ts";
import {
  addLongTermValidation,
  collectValidationData,
  createLookupBudget,
  createValidationFetch,
  describePadesLevel,
  readCms,
  resetValidationCache,
} from "./pdf-ltv.ts";
import {
  createSelfSignedSealIdentity,
  requestDocumentTimestamp,
  saveSealedPdf,
} from "./pdf-seal.ts";
import { sealForTheLongTerm } from "./seal-identity.ts";
import { startTestPki, type TestPki } from "./pki-test-support.ts";

const run = promisify(execFile);
const localFetch = createValidationFetch({ allowPrivateAddresses: true });

async function makePdf(): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);

  page.drawText("Signed agreement", {
    font: await pdf.embedFont(StandardFonts.Helvetica),
    x: 72,
    y: 700,
  });

  return pdf;
}

async function sealedWith(pki: TestPki, { timestamp = true } = {}) {
  return saveSealedPdf(await makePdf(), pki.seal, {
    name: "Harbour & Finch",
    reason: "Signed with SignuDoc",
    timestampUrl: timestamp ? pki.timestampUrl : null,
  });
}

async function withPki(run: (pki: TestPki) => Promise<void>) {
  resetValidationCache();

  const pki = await startTestPki();

  try {
    await run(pki);
  } finally {
    await pki.close();
  }
}

/** The bytes each signature's byte range covers hash to what it signed. */
function assertSignaturesCoverTheirRanges(bytes: Uint8Array) {
  for (const signature of findSignatures(bytes)) {
    const [a, b, c, d] = signature.byteRange;
    const covered = Buffer.concat([
      Buffer.from(bytes.subarray(a, a + b)),
      Buffer.from(bytes.subarray(c, c + d)),
    ]);
    const digest = createHash("sha256").update(covered).digest();
    const contents = signature.contents;
    // ContentInfo > SignedData > encapContentInfo or signerInfos.
    const signedData = children(
      contents,
      children(contents, readTlv(contents))[1]!,
    )[0]!;
    const parts = children(contents, signedData);
    const encapsulated = parts[2]!;
    const [type, wrapped] = children(contents, encapsulated);

    if (readOid(contents, type!) === "1.2.840.113549.1.9.16.1.4") {
      // A document timestamp: TSTInfo's messageImprint is the digest.
      const octets = children(contents, wrapped!)[0]!;
      const tstInfo = readTlv(contents, octets.contentStart, octets.end);
      const imprint = children(contents, tstInfo)[2]!;

      assert.deepEqual(
        contentBytes(contents, children(contents, imprint)[1]!),
        digest,
      );
    } else {
      const signerInfo = children(contents, parts[parts.length - 1]!)[0]!;
      const attributes = children(contents, children(contents, signerInfo)[3]!);
      const messageDigest = attributes.find(
        (attribute) =>
          readOid(contents, children(contents, attribute)[0]!) ===
          "1.2.840.113549.1.9.4",
      )!;
      const value = children(
        contents,
        children(contents, messageDigest)[1]!,
      )[0]!;

      assert.deepEqual(contentBytes(contents, value), digest);
    }

    // Nothing after a signature's range but later updates' bytes.
    assert.ok(c + d <= bytes.length);
  }
}

async function dssCounts(bytes: Uint8Array) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const dss = document.catalog.lookup(PDFName.of("DSS"), PDFDict);
  const count = (key: string) =>
    dss.lookupMaybe(PDFName.of(key), PDFArray)?.size() ?? 0;

  return { certs: count("Certs"), crls: count("CRLs"), ocsps: count("OCSPs") };
}

test("a CA-issued seal gets its chain, OCSP answers and an archive timestamp (B-LTA)", async (t) => {
  await withPki(async (pki) => {
    const sealed = await sealedWith(pki);

    assert.equal(await describePadesLevel(sealed), "B-T");

    const result = await addLongTermValidation(sealed, {
      fetch: localFetch,
      timestamp: (digest) => requestDocumentTimestamp(digest, pki.timestampUrl),
    });

    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.revoked, []);
    assert.equal(await describePadesLevel(result.bytes), "B-LTA");
    // The seal's issuer is not in the seal, but the time-stamping
    // service sends it with its tokens.
    assert.equal(pki.state.caFetches, 0);
    // The seal and the time-stamping certificates each got an answer.
    assert.equal(pki.state.ocspRequests, 2);

    const counts = await dssCounts(result.bytes);

    // Seal, CA, time-stamping authority.
    assert.equal(counts.certs, 3);
    assert.equal(counts.ocsps, 2);
    assert.equal(counts.crls, 0);

    // The first bytes are the sealed file, unchanged.
    assert.deepEqual(
      Buffer.from(result.bytes.subarray(0, sealed.length)),
      Buffer.from(sealed),
    );
    assert.equal(findSignatures(result.bytes).length, 2);
    assertSignaturesCoverTheirRanges(result.bytes);

    // pdf-lib still reads the file, as later steps do.
    await PDFDocument.load(result.bytes, { updateMetadata: false });

    try {
      await run("pdfsig", ["-v"]);
    } catch {
      t.diagnostic("pdfsig is not installed; skipped the poppler check");
      return;
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), "ltv-"));

    try {
      const file = path.join(directory, "lta.pdf");

      await writeFile(file, result.bytes);

      // pdfsig exits with an error for a signature it cannot check (the
      // archive timestamp), and where NSS has no database, so its report is
      // read either way.
      const { stdout } = await run("pdfsig", ["-nocert", file]).catch(
        (error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
      );

      // Poppler checks the seal, and lists the archive timestamp, which it
      // cannot check itself.
      assert.equal(
        stdout.match(/Signature Validation: Signature is Valid\./g)?.length,
        1,
        stdout,
      );
      assert.match(stdout, /SignuDoc archive timestamp/);

      // OpenSSL checks the archive timestamp against the bytes it covers
      // and the test CA.
      const archive = findSignatures(result.bytes).at(-1)!;
      const [a, b, c, d] = archive.byteRange;
      const covered = path.join(directory, "covered.bin");
      const token = path.join(directory, "token.der");
      const caFile = path.join(directory, "ca.pem");

      await writeFile(
        covered,
        Buffer.concat([
          Buffer.from(result.bytes.subarray(a, a + b)),
          Buffer.from(result.bytes.subarray(c, c + d)),
        ]),
      );
      await writeFile(token, archive.contents);
      await writeFile(
        caFile,
        `-----BEGIN CERTIFICATE-----\n${pki.caCertificate.toString("base64")}\n-----END CERTIFICATE-----\n`,
      );

      const verified = await run("openssl", [
        "ts",
        "-verify",
        "-data",
        covered,
        "-in",
        token,
        "-token_in",
        "-CAfile",
        caFile,
      ]).catch((error: { stderr?: string; stdout?: string }) => ({
        stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }));

      assert.match(verified.stdout, /Verification: OK/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

test("without OCSP, the revocation list is used", async () => {
  await withPki(async (pki) => {
    pki.state.ocspDown = true;

    const result = await addLongTermValidation(
      await sealedWith(pki, { timestamp: false }),
      {
        fetch: localFetch,
      },
    );
    const counts = await dssCounts(result.bytes);

    assert.deepEqual(result.revoked, []);
    assert.equal(counts.ocsps, 0);
    assert.equal(counts.crls, 1);
    assert.equal(pki.state.crlFetches, 1);
    // With no timestamp token to bring it, the seal's issuer came from the
    // address the seal certificate names.
    assert.equal(pki.state.caFetches, 1);
    assert.match(result.problems.join(" "), /OCSP at .* failed/);
    // A seal without a timestamp is B-B, whatever validation data it has.
    assert.equal(await describePadesLevel(result.bytes), "B-B");
  });
});

test("a revoked seal certificate is reported", async () => {
  await withPki(async (pki) => {
    pki.state.revoked.add("1001");

    const result = await addLongTermValidation(
      await sealedWith(pki, { timestamp: false }),
      {
        fetch: localFetch,
      },
    );

    assert.equal(result.revoked.length, 1);
    assert.match(result.revoked[0]!, /Harbour & Finch document seal/);
  });
});

test("adding the same validation data twice changes nothing", async () => {
  await withPki(async (pki) => {
    const once = await addLongTermValidation(await sealedWith(pki), {
      fetch: localFetch,
    });
    const twice = await addLongTermValidation(once.bytes, {
      fetch: localFetch,
    });

    assert.equal(twice.bytes.length, once.bytes.length);
  });
});

test("a time-stamping service that fails leaves the validation data in place", async () => {
  await withPki(async (pki) => {
    const result = await addLongTermValidation(await sealedWith(pki), {
      fetch: localFetch,
      timestamp: async () => {
        throw new Error("down");
      },
    });

    assert.equal(await describePadesLevel(result.bytes), "B-LT");
    assert.match(result.problems.join(" "), /archive timestamp failed: down/);
  });
});

test("the timestamp tokens and certificates inside a seal are found", async () => {
  await withPki(async (pki) => {
    const [signature] = findSignatures(await sealedWith(pki));
    const contents = readCms(signature!.contents);

    assert.equal(contents.certificates.length, 1);
    assert.equal(contents.timestampTokens.length, 1);
  });
});

test("addresses on this machine or a private network are not fetched", async () => {
  const guarded = createValidationFetch();

  for (const url of [
    "http://127.0.0.1/ca.cer",
    "http://localhost/ca.cer",
    "http://10.1.2.3/ocsp",
    "http://192.168.0.4/ocsp",
    "http://169.254.169.254/latest",
    "http://[::1]/ocsp",
    "http://[::ffff:127.0.0.1]/ocsp",
    "file:///etc/passwd",
  ]) {
    await assert.rejects(guarded(url), /Refused/, url);
  }
});

test("the install's seal is B-LTA with a CA certificate and a time-stamping service", async () => {
  await withPki(async (pki) => {
    const sealed = await sealForTheLongTerm(
      await makePdf(),
      pki.seal,
      {
        name: "Harbour & Finch",
        reason: "Signed",
        timestampUrl: pki.timestampUrl,
      },
      { fetch: localFetch },
    );

    assert.equal(await describePadesLevel(sealed), "B-LTA");
  });
});

test("with the time-stamping service down, a CA seal still gets its validation data", async () => {
  await withPki(async (pki) => {
    const original = console.error;

    console.error = () => {};

    try {
      const sealed = await sealForTheLongTerm(
        await makePdf(),
        pki.seal,
        {
          name: "Harbour & Finch",
          reason: "Signed",
          timestampUrl: pki.timestampUrl.replace("/tsa", "/missing"),
        },
        { fetch: localFetch },
      );

      assert.equal(await describePadesLevel(sealed), "B-B");
      assert.equal(await hasDocumentSecurityStore(sealed), true);
    } finally {
      console.error = original;
    }
  });
});

test("a self-made seal without a timestamp is left as it is", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const identity = createSelfSignedSealIdentity({
    commonName: "Test seal",
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
  });
  const sealed = await sealForTheLongTerm(await makePdf(), identity, {
    name: "SignuDoc",
    reason: "Signed",
  });

  assert.equal(await describePadesLevel(sealed), "B-B");
  assert.equal(await hasDocumentSecurityStore(sealed), false);
  assert.equal(findSignatures(sealed).length, 1);
});

test("a certificate authority that does not answer is given up on in time", async () => {
  const signals: (AbortSignal | undefined)[] = [];

  await withPki(async (pki) => {
    const sealed = await sealedWith(pki, { timestamp: false });
    const started = Date.now();
    const data = await collectValidationData(
      findSignatures(sealed).map((signature) => signature.contents),
      {
        budget: createLookupBudget(300),
        fetch: (_url, _request, options) => {
          signals.push(options?.signal);
          return new Promise<Buffer>(() => {});
        },
      },
    );

    assert.ok(Date.now() - started < 3_000);
    assert.match(data.problems.join(" "), /Ran out of time/);
    // Each lookup still under way was told to stop.
    assert.ok(signals.length > 0);
    assert.ok(signals.every((signal) => signal?.aborted));
  });
});

test("a lookup told to stop closes its connection", async () => {
  let closed = false;
  const server = createServer((request) => {
    // Never answers.
    request.on("close", () => {
      closed = true;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const controller = new AbortController();
    const lookup = createValidationFetch({
      allowPrivateAddresses: true,
      timeoutMs: 10_000,
    })(`http://127.0.0.1:${String(port)}/ocsp`, undefined, {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 100);

    const started = Date.now();

    await assert.rejects(lookup);
    assert.ok(Date.now() - started < 2_000);

    for (let wait = 0; wait < 20 && !closed; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(closed, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an answer without a next update is kept only while it is current", async () => {
  await withPki(async (pki) => {
    // A day old, less a moment: still current, but not for long.
    pki.state.ocspNextUpdate = false;
    pki.state.staleByMs = 24 * 60 * 60 * 1000 - 1500;

    const signatures = findSignatures(
      await sealedWith(pki, { timestamp: false }),
    ).map((signature) => signature.contents);
    const first = await collectValidationData(signatures, {
      fetch: localFetch,
    });
    const asked = pki.state.ocspRequests;

    assert.equal(first.ocsps.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 1700));

    // The cached answer is past its age now, so the responder is asked
    // again instead.
    const second = await collectValidationData(signatures, {
      fetch: localFetch,
    });

    assert.equal(pki.state.ocspRequests, asked + 1);
    assert.equal(second.ocsps.length, 1);
  });
});

test("one lookup budget covers the whole document, archive timestamp included", async () => {
  await withPki(async (pki) => {
    const sealed = await sealedWith(pki, { timestamp: false });
    const started = Date.now();
    const result = await addLongTermValidation(sealed, {
      budget: createLookupBudget(400),
      fetch: () => new Promise<Buffer>(() => {}),
      timestamp: () => new Promise<Buffer>(() => {}),
    });

    // Lookups and the timestamp share the 400 ms, rather than each getting
    // a budget of its own.
    assert.ok(Date.now() - started < 1_500, String(Date.now() - started));
    assert.match(result.problems.join(" "), /archive timestamp failed/);
  });
});

test("a redirect's body is not read", async () => {
  let streaming: ReturnType<typeof setInterval> | undefined;
  let redirectClosed = false;
  const server = createServer((request, response) => {
    if (request.url === "/start") {
      // A body that never ends, sent with the redirect.
      response.writeHead(302, { location: "/final" });
      streaming = setInterval(() => response.write(Buffer.alloc(65_536)), 1);
      response.on("close", () => {
        clearInterval(streaming);
        redirectClosed = true;
      });
      return;
    }

    response.writeHead(200).end("final");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const body = await createValidationFetch({
      allowPrivateAddresses: true,
      maxBytes: 1024,
      timeoutMs: 2000,
    })(`http://127.0.0.1:${String(port)}/start`);

    assert.equal(body.toString(), "final");

    // The redirect's connection is closed, not left downloading.
    for (let wait = 0; wait < 20 && !redirectClosed; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(redirectClosed, true);
  } finally {
    clearInterval(streaming);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a host name that resolves to a private address is not fetched", async () => {
  await withPki(async (pki) => {
    const port = new URL(pki.timestampUrl).port;
    const toLoopback = (
      _hostname: string,
      callback: (
        error: Error | null,
        addresses: { address: string; family: number }[],
      ) => void,
    ) => callback(null, [{ address: "127.0.0.1", family: 4 }]);
    const guarded = createValidationFetch({ lookup: toLoopback });

    await assert.rejects(
      guarded(`http://ca.example.test:${port}/ca.cer`),
      /private address \(ca\.example\.test is 127\.0\.0\.1\)/,
    );
    assert.equal(pki.state.caFetches, 0);

    // The connection goes to the address the lookup gave.
    const allowed = createValidationFetch({
      allowPrivateAddresses: true,
      lookup: toLoopback,
    });

    assert.ok(
      (await allowed(`http://ca.example.test:${port}/ca.cer`)).length > 0,
    );
    assert.equal(pki.state.caFetches, 1);
  });
});

test("an OCSP answer from a responder the CA authorized is used", async () => {
  await withPki(async (pki) => {
    pki.state.ocspSigner = "delegated";

    const data = await collectValidationData(
      findSignatures(await sealedWith(pki, { timestamp: false })).map(
        (signature) => signature.contents,
      ),
      { fetch: localFetch },
    );

    assert.equal(data.ocsps.length, 1);
    assert.equal(pki.state.crlFetches, 0);
    // The responder's certificate goes in too, without a check of its own.
    assert.equal(data.certificates.length, 3);
  });
});

test("an OCSP answer signed by another of the CA's certificates is refused", async () => {
  await withPki(async (pki) => {
    pki.state.ocspSigner = "unauthorized";

    const data = await collectValidationData(
      findSignatures(await sealedWith(pki, { timestamp: false })).map(
        (signature) => signature.contents,
      ),
      { fetch: localFetch },
    );

    assert.match(data.problems.join(" "), /signature does not verify/);
    // The revocation list is used instead.
    assert.equal(data.ocsps.length, 0);
    assert.equal(data.crls.length, 1);
  });
});

test("out-of-date revocation answers are refused", async () => {
  await withPki(async (pki) => {
    // Older than both answers' next update.
    pki.state.staleByMs = 3 * 24 * 60 * 60 * 1000;

    const data = await collectValidationData(
      findSignatures(await sealedWith(pki, { timestamp: false })).map(
        (signature) => signature.contents,
      ),
      { fetch: localFetch },
    );

    assert.equal(data.ocsps.length, 0);
    assert.equal(data.crls.length, 0);
    assert.match(data.problems.join(" "), /OCSP answer is out of date/);
    assert.match(data.problems.join(" "), /revocation list is out of date/);
  });
});

/** A critical revocation list extension, as the test CA adds it. */
function criticalExtension(oid: string, value: Buffer): Buffer {
  return der.sequence(
    der.oid(oid),
    encode(TAG.boolean, Buffer.from([0xff])),
    der.octets(value),
  );
}

test("revocation lists that may leave a certificate out are refused", async () => {
  /** An issuing distribution point for one address, [0] fullName. */
  const forPoint = (url: string) =>
    criticalExtension(
      "2.5.29.28",
      der.sequence(
        encode(0xa0, encode(0xa0, encode(0x86, Buffer.from(url, "latin1")))),
      ),
    );
  const lists: {
    expect: RegExp | null;
    extension: Buffer | ((crlUrl: string) => Buffer);
    name: string;
  }[] = [
    {
      // A delta list only has what changed since its base list.
      expect: /delta list/,
      extension: criticalExtension("2.5.29.27", encodeSmallInteger(1)),
      name: "delta",
    },
    {
      // Only key compromise.
      expect: /only some certificates or reasons/,
      extension: criticalExtension(
        "2.5.29.28",
        der.sequence(encode(0x83, Buffer.from([0x07, 0x40]))),
      ),
      name: "some reasons",
    },
    {
      expect: /only some certificates or reasons/,
      extension: criticalExtension(
        "2.5.29.28",
        der.sequence(encode(0x82, Buffer.from([0xff]))),
      ),
      name: "CA certificates only",
    },
    {
      expect: /critical extension 1\.2\.3\.4/,
      extension: criticalExtension("1.2.3.4", Buffer.from([0x05, 0x00])),
      name: "unknown critical extension",
    },
    {
      // A list of end-entity certificates covers the seal certificate.
      expect: null,
      extension: criticalExtension(
        "2.5.29.28",
        der.sequence(encode(0x81, Buffer.from([0xff]))),
      ),
      name: "user certificates only",
    },
    {
      // A list for another partition of the CA's certificates.
      expect: /distribution point the certificate does not name/,
      extension: () => forPoint("http://127.0.0.1:1/other-partition.crl"),
      name: "another distribution point",
    },
    {
      // The list the certificate points to.
      expect: null,
      extension: (crlUrl) => forPoint(crlUrl),
      name: "the certificate's distribution point",
    },
  ];

  for (const list of lists) {
    await withPki(async (pki) => {
      pki.state.ocspDown = true;
      pki.state.crlExtensions = [
        typeof list.extension === "function"
          ? list.extension(new URL("/ca.crl", pki.timestampUrl).toString())
          : list.extension,
      ];

      const data = await collectValidationData(
        findSignatures(await sealedWith(pki, { timestamp: false })).map(
          (signature) => signature.contents,
        ),
        { fetch: localFetch },
      );

      if (list.expect) {
        assert.equal(data.crls.length, 0, list.name);
        assert.match(data.problems.join(" "), list.expect, list.name);
      } else {
        assert.equal(data.crls.length, 1, list.name);
      }
    });
  }
});

test("revocation answers dated in the future are refused", async () => {
  await withPki(async (pki) => {
    pki.state.staleByMs = -60 * 60 * 1000;

    const data = await collectValidationData(
      findSignatures(await sealedWith(pki, { timestamp: false })).map(
        (signature) => signature.contents,
      ),
      { fetch: localFetch },
    );

    assert.equal(data.ocsps.length + data.crls.length, 0);
    assert.match(data.problems.join(" "), /dated in the future/);
  });
});
