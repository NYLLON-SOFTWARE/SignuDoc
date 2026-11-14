import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  constants,
  createHash,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";

import type { FieldRecord } from "../schemas/field.ts";
import {
  algorithm,
  contextTag,
  der,
  encode,
  encodeSmallInteger,
} from "./der.ts";
import { fillSignature, findSignatures } from "./pdf-incremental.ts";
import {
  addLongTermValidation,
  createValidationFetch,
  describePadesLevel,
  parseCertificate,
  resetValidationCache,
} from "./pdf-ltv.ts";
import {
  prepareRevisionZero,
  prepareSignerRevision,
  SIGNER_SIGNATURE_BYTES,
} from "./pdf-revision.ts";
import { buildCadesSignature, requestDocumentTimestamp } from "./pdf-seal.ts";
import { startTestPki, type TestPki } from "./pki-test-support.ts";
import {
  addSignatureTimestamp,
  assembleSignedData,
  buildSignedAttributes,
  certificateHolderNames,
  certificateMatchesName,
  checkSignerSignature,
  CMS_OIDS,
  ecdsaSignatureAsDer,
  SignerSignatureError,
} from "./signer-cms.ts";

const run = promisify(execFile);
const localFetch = createValidationFetch({ allowPrivateAddresses: true });
const now = Math.floor(Date.now() / 1000);

async function makeSource(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const label of ["Page one", "Page two"]) {
    pdf.addPage([612, 792]).drawText(label, { font, x: 72, y: 720 });
  }

  return pdf.save();
}

function field(overrides: Partial<FieldRecord>): FieldRecord {
  return {
    createdAt: now - 500,
    height: 0.05,
    page: 1,
    required: true,
    signerId: "signer-1",
    submittedAt: now,
    type: "text",
    updatedAt: now,
    width: 0.3,
    x: 0.1,
    y: 0.1,
    ...overrides,
  } as FieldRecord;
}

const aliceFields = [
  field({
    id: "a-sign",
    inputMethod: "typed",
    type: "signature",
    value: "Alice Example",
    y: 0.7,
  }),
  field({ id: "a-text", type: "text", value: "Senior buyer", y: 0.8 }),
  field({
    checked: true,
    id: "a-check",
    type: "checkbox",
    width: 0.03,
    y: 0.85,
  }),
];
const bobFields = [
  field({
    id: "b-sign",
    inputMethod: "typed",
    page: 2,
    signerId: "signer-2",
    type: "signature",
    value: "Bob Example",
    y: 0.7,
  }),
  field({
    id: "b-date",
    page: 2,
    signerId: "signer-2",
    type: "date",
    value: "14 November 2026",
    y: 0.8,
  }),
];

/** Signs a prepared revision the way a provider would, and fills it in. */
async function signRevision(
  prepared: { bytes: Uint8Array; digest: Buffer },
  signer: { certificateChainPem: string[]; privateKeyPem: string },
  {
    level = "qualified",
    timestampUrl = null,
  }: { level?: "advanced" | "qualified"; timestampUrl?: string | null } = {},
) {
  const [signature] = findSignatures(prepared.bytes).slice(-1);
  const covered = Buffer.concat([
    Buffer.from(prepared.bytes.subarray(0, signature!.byteRange[1])),
    Buffer.from(
      prepared.bytes.subarray(
        signature!.byteRange[2],
        signature!.byteRange[2] + signature!.byteRange[3],
      ),
    ),
  ]);

  assert.deepEqual(
    createHash("sha256").update(covered).digest(),
    prepared.digest,
  );

  let cms: Buffer = Buffer.from(await buildCadesSignature(covered, signer));

  if (timestampUrl) {
    cms = await addSignatureTimestamp(cms, (imprint) =>
      requestDocumentTimestamp(imprint, timestampUrl),
    );
  }

  const checked = checkSignerSignature(cms, prepared.digest, { level });

  return { bytes: fillSignature(prepared.bytes, cms), checked };
}

async function withPki(body: (pki: TestPki) => Promise<void>) {
  resetValidationCache();

  const pki = await startTestPki();

  try {
    await body(pki);
  } finally {
    await pki.close();
    resetValidationCache();
  }
}

async function pdfsig(bytes: Uint8Array): Promise<string | null> {
  try {
    await run("pdfsig", ["-v"]);
  } catch {
    return null;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "revision-"));

  try {
    const file = path.join(directory, "signed.pdf");

    await writeFile(file, bytes);

    // pdfsig exits with an error for a signature it cannot check (an
    // archive timestamp), and where NSS has no database.
    const { stdout } = await run("pdfsig", ["-nocert", file]).catch(
      (error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
    );

    return stdout;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("each signer's revision keeps the signatures before it valid", async (t) => {
  await withPki(async (pki) => {
    const alice = pki.issueSigner({
      commonName: "Alice Example",
      qualified: true,
    });
    const bob = pki.issueSigner({ commonName: "Bob Example", qualified: true });
    const revisionZero = await prepareRevisionZero(await makeSource());
    const first = await signRevision(
      await prepareSignerRevision(revisionZero, {
        fields: aliceFields,
        images: new Map(),
        signature: {
          fieldName: "Alice Example (signer 1)",
          name: "Alice Example",
          reason: "Signed with SignuDoc",
          signingTime: new Date(),
        },
      }),
      alice,
      { timestampUrl: pki.timestampUrl },
    );

    assert.equal(first.checked.qualified, true);
    assert.equal(first.checked.timestamped, true);
    assert.match(first.checked.subject, /Alice Example/);

    // The first revision is the file it was made from, with more after it.
    assert.deepEqual(
      Buffer.from(first.bytes.subarray(0, revisionZero.length)),
      Buffer.from(revisionZero),
    );

    const second = await signRevision(
      await prepareSignerRevision(first.bytes, {
        fields: bobFields,
        images: new Map(),
        signature: {
          fieldName: "Bob Example (signer 2)",
          name: "Bob Example",
          signingTime: new Date(),
        },
      }),
      bob,
    );

    assert.deepEqual(
      Buffer.from(second.bytes.subarray(0, first.bytes.length)),
      Buffer.from(first.bytes),
    );

    const signatures = findSignatures(second.bytes);

    assert.equal(signatures.length, 2);
    assert.equal(signatures[0]!.subFilter, "ETSI.CAdES.detached");
    // The second signature covers the whole file.
    assert.equal(
      signatures[1]!.byteRange[2] + signatures[1]!.byteRange[3],
      second.bytes.length,
    );

    // The values are on the pages as locked annotations, and the signature
    // widgets show each signer's signature.
    const loaded = await PDFDocument.load(second.bytes);
    const annotations = loaded
      .getPages()
      .map((page) => page.node.Annots()?.size() ?? 0);

    assert.deepEqual(annotations, [3, 2]);
    assert.equal(loaded.getPageCount(), 2);

    const fields = loaded.getForm().getFields();

    assert.deepEqual(
      fields.map((item) => item.getName()),
      ["Alice Example (signer 1)", "Bob Example (signer 2)"],
    );

    for (const item of fields) {
      assert.ok(
        item.acroField.getWidgets()[0]!.dict.get(PDFName.of("AP")),
        "the signature widget has an appearance",
      );
    }

    // Then the install's long-term validation on top: B-LTA.
    const finished = await addLongTermValidation(second.bytes, {
      fetch: localFetch,
      timestamp: (digest) => requestDocumentTimestamp(digest, pki.timestampUrl),
    });

    assert.deepEqual(finished.problems, []);
    assert.equal(await describePadesLevel(finished.bytes), "B-LTA");

    const report = await pdfsig(finished.bytes);

    if (report === null) {
      t.diagnostic("pdfsig is not installed; skipped the poppler check");
      return;
    }

    assert.equal(
      report.match(/Signature Validation: Signature is Valid\./g)?.length,
      2,
      report,
    );
    assert.match(report, /Signer Certificate Common Name: Alice Example/);
    assert.match(report, /Signer Certificate Common Name: Bob Example/);
  });
});

test("a signature for other content, or by another key, is refused", async () => {
  await withPki(async (pki) => {
    const alice = pki.issueSigner({
      commonName: "Alice Example",
      qualified: true,
    });
    const revisionZero = await prepareRevisionZero(await makeSource());
    const prepared = await prepareSignerRevision(revisionZero, {
      fields: aliceFields,
      images: new Map(),
      signature: { fieldName: "Alice", signingTime: new Date() },
    });
    const otherContent = Buffer.from(
      await buildCadesSignature(Buffer.from("something else"), alice),
    );

    assert.throws(
      () =>
        checkSignerSignature(otherContent, prepared.digest, {
          level: "advanced",
        }),
      /different content/,
    );

    // Alice's certificate with Bob's key.
    const bob = pki.issueSigner({ commonName: "Bob Example" });
    const [signature] = findSignatures(prepared.bytes);
    const covered = Buffer.concat([
      Buffer.from(prepared.bytes.subarray(0, signature!.byteRange[1])),
      Buffer.from(prepared.bytes.subarray(signature!.byteRange[2])),
    ]);
    const forged = Buffer.from(
      await buildCadesSignature(covered, {
        certificateChainPem: alice.certificateChainPem,
        privateKeyPem: bob.privateKeyPem,
      }),
    );

    assert.throws(
      () =>
        checkSignerSignature(forged, prepared.digest, { level: "advanced" }),
      /does not verify/,
    );
  });
});

test("a qualified signature needs a qualified certificate", async () => {
  await withPki(async (pki) => {
    const plain = pki.issueSigner({ commonName: "Carol Example" });
    const prepared = await prepareSignerRevision(
      await prepareRevisionZero(await makeSource()),
      {
        fields: aliceFields,
        images: new Map(),
        signature: { fieldName: "Carol", signingTime: new Date() },
      },
    );

    await assert.rejects(
      signRevision(prepared, plain, { level: "qualified" }),
      (error: unknown) =>
        error instanceof SignerSignatureError &&
        /not a qualified certificate/.test(error.message),
    );

    const advanced = await signRevision(prepared, plain, { level: "advanced" });

    assert.equal(advanced.checked.qualified, false);
  });
});

test("a signature timestamp counts only when it is for the signature and verifies", async () => {
  await withPki(async (pki) => {
    const alice = pki.issueSigner({ commonName: "Alice Example" });
    const prepared = await prepareSignerRevision(
      await prepareRevisionZero(await makeSource()),
      {
        fields: aliceFields,
        images: new Map(),
        signature: { fieldName: "Alice", signingTime: new Date() },
      },
    );
    const [signature] = findSignatures(prepared.bytes);
    const covered = Buffer.concat([
      Buffer.from(prepared.bytes.subarray(0, signature!.byteRange[1])),
      Buffer.from(prepared.bytes.subarray(signature!.byteRange[2])),
    ]);
    const plain = Buffer.from(await buildCadesSignature(covered, alice));
    const timestampCount = (cms: Buffer) =>
      cms.toString("latin1").split(
        // The timeStampToken attribute's OID, as DER.
        Buffer.from("060b2a864886f70d010910020e", "hex").toString("latin1"),
      ).length - 1;
    const check = (cms: Buffer) =>
      checkSignerSignature(cms, prepared.digest, { level: "advanced" });

    // An empty timestamp attribute, a token for another signature, and
    // something that is not a token at all.
    const empty = await addSignatureTimestamp(plain, async () =>
      Buffer.alloc(0),
    );
    const otherSignature = await addSignatureTimestamp(plain, () =>
      requestDocumentTimestamp(Buffer.alloc(32, 7), pki.timestampUrl),
    );
    const notAToken = await addSignatureTimestamp(plain, async () =>
      Buffer.from("3000", "hex"),
    );

    for (const cms of [plain, empty, otherSignature, notAToken]) {
      assert.equal(check(cms).timestamped, false);
    }

    // Each is replaced by a real one, and only one is left.
    for (const cms of [empty, otherSignature, notAToken]) {
      const repaired = await addSignatureTimestamp(cms, (imprint) =>
        requestDocumentTimestamp(imprint, pki.timestampUrl),
      );

      assert.equal(check(repaired).timestamped, true);
      assert.equal(timestampCount(repaired), 1);

      // One that checks out is kept as it is.
      const again = await addSignatureTimestamp(repaired, () => {
        throw new Error("A good timestamp is not replaced.");
      });

      assert.deepEqual(again, repaired);
    }
  });
});

test("raw ECDSA r and s are encoded, even when they start like a SEQUENCE", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const data = Buffer.from("signed attributes");
  const raw = sign("sha256", data, {
    dsaEncoding: "ieee-p1363",
    key: privateKey,
  });
  const asDer = ecdsaSignatureAsDer(raw);

  assert.ok(
    verify("sha256", data, { dsaEncoding: "der", key: publicKey }, asDer),
  );

  // A signature already in DER is left alone.
  const alreadyDer = sign("sha256", data, {
    dsaEncoding: "der",
    key: privateKey,
  });

  assert.deepEqual(ecdsaSignatureAsDer(alreadyDer), alreadyDer);

  // 64 raw bytes whose first two read as a 62-byte SEQUENCE.
  const lookalike = Buffer.concat([
    Buffer.from([0x30, 0x3e, 0x04, 0x3c]),
    Buffer.alloc(60, 0x11),
  ]);
  const encoded = ecdsaSignatureAsDer(lookalike);

  assert.notDeepEqual(encoded, lookalike);
  assert.deepEqual(
    encoded,
    Buffer.concat([
      Buffer.from([0x30, 0x44, 0x02, 0x20]),
      lookalike.subarray(0, 32),
      Buffer.from([0x02, 0x20]),
      lookalike.subarray(32),
    ]),
  );
});

test("a certificate matches the name a signer was sent the document under", async () => {
  await withPki(async (pki) => {
    const plain = parseCertificate(
      pki.issueSigner({ commonName: "Alice Example" }).certificate,
    );
    const national = parseCertificate(
      pki.issueSigner({
        commonName: "MÄNNIK,MARI-LIIS,47101010033",
        givenName: "MARI-LIIS",
        surname: "MÄNNIK",
      }).certificate,
    );

    assert.deepEqual(certificateHolderNames(national), [
      "MARI-LIIS MÄNNIK",
      "MÄNNIK,MARI-LIIS,47101010033",
    ]);

    for (const name of [
      "Alice Example",
      "alice example",
      "Example, Alice",
      "Dr. Alice Example",
      "Alice B. Example",
    ]) {
      assert.equal(certificateMatchesName(plain, name), true, name);
    }

    for (const name of ["Bob Example", "Alice", "Alice Sample", ""]) {
      assert.equal(certificateMatchesName(plain, name), false, name);
    }

    // Accents, hyphens, case and the ID code in the common name do not count.
    for (const name of [
      "Mari-Liis Männik",
      "Mari Liis Mannik",
      "Männik Mari-Liis",
    ]) {
      assert.equal(certificateMatchesName(national, name), true, name);
    }

    assert.equal(certificateMatchesName(national, "Kadri Männik"), false);

    // An apostrophe joins the letters around it, however it is typed.
    const irish = parseCertificate(
      pki.issueSigner({ commonName: "Alice O'Connor" }).certificate,
    );

    for (const name of ["Alice OConnor", "Alice O’Connor", "alice o'connor"]) {
      assert.equal(certificateMatchesName(irish, name), true, name);
    }

    assert.equal(certificateMatchesName(irish, "Alice Connor"), false);
  });
});

test("an RSA-PSS signature is checked only with a mask it says it uses", async () => {
  await withPki(async (pki) => {
    const alice = pki.issueSigner({ commonName: "Alice Example" });
    const digest = createHash("sha256").update("revision bytes").digest();
    const signedAttributes = buildSignedAttributes({
      certificate: alice.certificate,
      contentDigest: digest,
    });
    // SHA-256, MGF1 with SHA-256, a 32-byte salt.
    const signature = sign("sha256", signedAttributes, {
      key: alice.privateKeyPem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
    const cmsDeclaring = (maskHash: string) =>
      assembleSignedData({
        certificates: [alice.certificate, pki.caCertificate],
        signature,
        signatureAlgorithm: der.sequence(
          der.oid(CMS_OIDS.rsaPss),
          der.sequence(
            encode(contextTag(0), algorithm(CMS_OIDS.sha256)),
            encode(
              contextTag(1),
              der.sequence(der.oid(CMS_OIDS.mgf1), algorithm(maskHash)),
            ),
            encode(contextTag(2), encodeSmallInteger(32)),
          ),
        ),
        signedAttributes,
      });

    assert.match(
      checkSignerSignature(cmsDeclaring(CMS_OIDS.sha256), digest, {
        level: "advanced",
      }).subject,
      /Alice Example/,
    );
    // The same signature, declaring a mask over SHA-1: not checked as one.
    assert.throws(
      () =>
        checkSignerSignature(cmsDeclaring(CMS_OIDS.sha1), digest, {
          level: "advanced",
        }),
      (error: unknown) =>
        error instanceof SignerSignatureError &&
        /RSA-PSS signature uses parameters that cannot be checked/.test(
          error.message,
        ),
    );
  });
});

test("the signature slot fits a chain and a timestamp", () => {
  assert.ok(SIGNER_SIGNATURE_BYTES >= 16_384);
});
