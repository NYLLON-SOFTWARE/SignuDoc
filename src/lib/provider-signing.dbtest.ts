import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { PDFDocument, StandardFonts } from "pdf-lib";
import pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import {
  EnvelopeMutationError,
  getEnvelopeDetailDataForUser,
  getReviewEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import {
  ProviderSigningError,
  resumeProviderSigning,
  startProviderSigning,
} from "./provider-signing.ts";
import { runRetentionSweep } from "./retention.ts";
import { invalidateSettingsCache } from "./settings.ts";
import { verifyAuditChain } from "./services/audit.ts";
import { findSignatures } from "./services/pdf-incremental.ts";
import { resetValidationCache } from "./services/pdf-ltv.ts";
import { resetSealIdentityCache } from "./services/seal-identity.ts";
import { startTestPki, type TestPki } from "./services/pki-test-support.ts";
import { checkSignerSignature } from "./services/signer-cms.ts";
import {
  followSigner,
  STAND_IN_CLIENT,
  startProviderStandIns,
  type ProviderStandIns,
} from "./services/signing-provider-test-support.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import { getRecipientCertificateKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  recordSignerConsent,
  SigningMutationError,
  submitSigningForToken,
} from "./signing.ts";

// Signatures in the signers' own names, through a signing provider, against
// a real Postgres: the sender's choice, each signer's trip to the provider
// and back, and the signed PDF with one signature per signer. The provider
// is the eID Easy stand-in, signing with certificates from the test CA.
// Run with `npm run test:db`.

const run = promisify(execFile);

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
let pki: TestPki;
let standIns: ProviderStandIns;
const createdUsers: string[] = [];
const envBefore = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (!envBefore.has(name)) {
      envBefore.set(name, process.env[name]);
    }

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

before(async () => {
  database = await openTestDatabase();
  // The invitation email reads the install's name through the shared pool.
  globalThis.__signudocPgPool = database;
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-provider-"));
  resetValidationCache();
  pki = await startTestPki();

  const signer = pki.issueSigner({
    commonName: "Qualified Signer",
    qualified: true,
  });

  standIns = await startProviderStandIns({
    chain: [signer.certificate, pki.caCertificate],
    privateKeyPem: signer.privateKeyPem,
  });
  setEnv({
    APP_URL: "https://sign.example.test",
    // Only the eID Easy stand-in: a CSC provider set in the shell would
    // otherwise be the one these tests use, or find when none is set.
    CSC_API_URL: undefined,
    CSC_CLIENT_ID: undefined,
    CSC_CLIENT_SECRET: undefined,
    EIDEASY_API_URL: standIns.eidEasyUrl,
    EIDEASY_CLIENT_ID: STAND_IN_CLIENT.id,
    EIDEASY_SECRET: STAND_IN_CLIENT.secret,
    EMAIL_CAPTURE_DIR: path.join(storageDir, "outbox"),
    EMAIL_DRIVER: "capture",
    SEAL_TIMESTAMP_URL: undefined,
    SIGNING_PROVIDER: undefined,
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();

  for (const [name, value] of envBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await standIns.close();
  await pki.close();
  resetValidationCache();
  await rm(storageDir, { force: true, recursive: true });
});

/** A draft with two signers, each with a signature field. */
async function createDraft() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const sourcePdf = await PDFDocument.create();
  const font = await sourcePdf.embedFont(StandardFonts.Helvetica);

  sourcePdf
    .addPage([612, 792])
    .drawText("Supply agreement", { font, x: 72, y: 720 });

  const sourceBytes = await sourcePdf.save();
  const sourceKey = `test/${envelopeId}/source.pdf`;

  createdUsers.push(userId);
  await storageService.putObject({
    body: sourceBytes,
    contentType: "application/pdf",
    key: sourceKey,
  });
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Supply agreement', 'draft', $3, 'supply.pdf', $4, 1, $5)
    `,
    [
      envelopeId,
      userId,
      sourceKey,
      sourceBytes.length,
      createHash("sha256").update(sourceBytes).digest("hex"),
    ],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      signers: [
        { email: "riley@example.test", name: "Riley Recipient" },
        { email: "casey@example.test", name: "Casey Second" },
      ],
    },
    database,
  );
  const [riley, casey] = saved.signers.map((signer) => signer.id);
  const fields = await replaceDraftEnvelopeFields(
    userId,
    envelopeId,
    {
      fields: [
        {
          height: 0.06,
          page: 1,
          required: true,
          signerId: riley,
          type: "signature",
          width: 0.3,
          x: 0.1,
          y: 0.6,
        },
        {
          height: 0.04,
          page: 1,
          required: true,
          signerId: riley,
          type: "text",
          width: 0.3,
          x: 0.1,
          y: 0.7,
        },
        {
          height: 0.06,
          page: 1,
          required: true,
          signerId: casey,
          type: "signature",
          width: 0.3,
          x: 0.5,
          y: 0.6,
        },
      ],
    },
    database,
  );
  const fieldsFor = (signerId: string) =>
    fields.fields
      .filter((field) => field.signerId === signerId)
      .map((field) => ({ id: field.id!, type: field.type }));

  return {
    casey: { fields: fieldsFor(casey!), id: casey!, name: "Casey Second" },
    envelopeId,
    riley: { fields: fieldsFor(riley!), id: riley!, name: "Riley Recipient" },
    userId,
  };
}

function send(
  draft: { envelopeId: string; userId: string },
  signatureLevel: "advanced" | "qualified" | "simple",
) {
  return sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    {
      senderEmail: "sam@example.test",
      senderName: "Sam Sender",
      signatureLevel,
    },
    { database },
  );
}

/**
 * A signing link for whoever's turn it is, and their consent. (The real
 * link went out by email.)
 */
async function linkFor(signerId: string) {
  const link = await issueSigningLink({ expiresInSeconds: 3600 });

  await database.query(
    `
      update signers
      set signing_token_hash = $1, signing_token_expires_at = $2
      where id = $3
    `,
    [link.tokenHash, link.exp, signerId],
  );
  await recordSignerConsent(
    link.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );

  return link.token;
}

function submissionFor(signer: {
  fields: { id: string; type: string }[];
  name: string;
}) {
  return {
    clientTimezoneOffsetMinutes: 0,
    fields: signer.fields.map((field) =>
      field.type === "signature"
        ? {
            fieldId: field.id,
            inputMethod: "typed",
            type: "signature",
            value: signer.name,
          }
        : { fieldId: field.id, type: field.type, value: "Senior buyer" },
    ),
  };
}

const certificates = new Map<string, ReturnType<TestPki["issueSigner"]>>();

/** A qualified certificate in this name, from the test CA. */
function certificateFor(name: string) {
  const issued =
    certificates.get(name) ??
    pki.issueSigner({ commonName: name, qualified: true });

  certificates.set(name, issued);

  return {
    chain: [issued.certificate, pki.caCertificate],
    privateKeyPem: issued.privateKeyPem,
  };
}

/**
 * The signer goes to the provider, signs (with a certificate in their own
 * name, unless `as` names someone else), and comes back.
 */
async function signAtProvider(
  token: string,
  signer: { fields: { id: string; type: string }[]; name: string },
  { as = signer.name }: { as?: string } = {},
) {
  standIns.setSigner(certificateFor(as));

  const started = await startProviderSigning(token, submissionFor(signer), {
    database,
    storageService,
  });
  const query = await followSigner(started.redirectUrl);

  return {
    query,
    finish: () =>
      resumeProviderSigning(query.get("state") ?? "", query, {
        database,
        storageService,
        verifiedMethodsFor: () => [],
      }),
  };
}

async function sessionStates(envelopeId: string) {
  const result = await database.query<{ state: string }>(
    `select state from provider_signing_sessions where envelope_id = $1`,
    [envelopeId],
  );

  // Sessions started in the same second have no order between them.
  return result.rows.map((row) => row.state).sort();
}

async function stored(key: string) {
  return (await storageService.headObject(key)).exists;
}

test("the sender can choose a provider's signature only when the install has one", async () => {
  const draft = await createDraft();

  assert.deepEqual(
    (
      await getReviewEnvelopeDataForUser(
        draft.userId,
        draft.envelopeId,
        database,
      )
    )?.signingProvider,
    { name: "eID Easy" },
  );

  setEnv({ EIDEASY_CLIENT_ID: undefined });

  try {
    assert.equal(
      (
        await getReviewEnvelopeDataForUser(
          draft.userId,
          draft.envelopeId,
          database,
        )
      )?.signingProvider,
      null,
    );
    await assert.rejects(
      send(draft, "qualified"),
      (error: unknown) =>
        error instanceof EnvelopeMutationError &&
        error.statusCode === 400 &&
        /no signing provider/.test(error.message),
    );
  } finally {
    setEnv({ EIDEASY_CLIENT_ID: STAND_IN_CLIENT.id });
  }

  const status = await database.query<{ status: string }>(
    `select status from envelopes where id = $1`,
    [draft.envelopeId],
  );

  assert.equal(status.rows[0]?.status, "draft");
});

test("two signers sign with qualified signatures, each in a revision of their own", async (t) => {
  const draft = await createDraft();

  await send(draft, "qualified");

  const sent = await database.query<{
    signature_level: string;
    signature_provider: string;
  }>(
    `select signature_level, signature_provider from envelopes where id = $1`,
    [draft.envelopeId],
  );

  assert.deepEqual(sent.rows[0], {
    signature_level: "qualified",
    signature_provider: "eideasy",
  });

  // Signing here directly is refused: this envelope is signed at the
  // provider.
  const rileyToken = await linkFor(draft.riley.id);

  await assert.rejects(
    submitSigningForToken(rileyToken, submissionFor(draft.riley), {
      database,
      storageService,
    }),
    SigningMutationError,
  );

  // Riley signs.
  const riley = await signAtProvider(rileyToken, draft.riley);
  const rileyDone = await riley.finish();

  assert.ok("redirectPath" in rileyDone);

  const afterRiley = await database.query<{
    revision_key: string;
    revision_sha256: string;
    status: string;
  }>(
    `select revision_key, revision_sha256, status from envelopes where id = $1`,
    [draft.envelopeId],
  );
  const firstRevisionKey = afterRiley.rows[0]!.revision_key;
  const firstRevision = (await storageService.getObject(firstRevisionKey)).body;

  assert.equal(afterRiley.rows[0]!.status, "sent");
  assert.equal(
    createHash("sha256").update(firstRevision).digest("hex"),
    afterRiley.rows[0]!.revision_sha256,
  );
  assert.equal(findSignatures(firstRevision).length, 1);

  // A second return for the same session does not sign again.
  await assert.rejects(
    resumeProviderSigning(riley.query.get("state") ?? "", riley.query, {
      database,
      storageService,
      verifiedMethodsFor: () => [],
    }),
    (error: unknown) =>
      error instanceof ProviderSigningError && error.problem === "expired",
  );

  // Casey signs on top of Riley's revision, and that finishes the envelope.
  const casey = await signAtProvider(
    await linkFor(draft.casey.id),
    draft.casey,
  );

  await casey.finish();

  const finished = await database.query<{
    revision_key: string;
    signed_pdf_key: string;
    status: string;
  }>(
    `select revision_key, signed_pdf_key, status from envelopes where id = $1`,
    [draft.envelopeId],
  );

  assert.equal(finished.rows[0]!.status, "completed");
  assert.deepEqual(await sessionStates(draft.envelopeId), [
    "completed",
    "completed",
  ]);
  // Riley's revision is inside Casey's, so it is not kept on its own.
  assert.equal(await stored(firstRevisionKey), false);

  const signedPdf = (
    await storageService.getObject(finished.rows[0]!.signed_pdf_key)
  ).body;

  // Riley's revision is the start of the signed PDF, byte for byte.
  assert.deepEqual(
    Buffer.from(signedPdf.subarray(0, firstRevision.length)),
    Buffer.from(firstRevision),
  );

  const signatures = findSignatures(signedPdf).filter(
    (signature) => signature.subFilter === "ETSI.CAdES.detached",
  );

  assert.equal(signatures.length, 2);

  for (const signature of signatures) {
    const [, firstLength, restStart, restLength] = signature.byteRange;
    const digest = createHash("sha256")
      .update(signedPdf.subarray(0, firstLength))
      .update(signedPdf.subarray(restStart, restStart + restLength))
      .digest();
    const checked = checkSignerSignature(signature.contents, digest, {
      level: "qualified",
    });

    assert.equal(checked.qualified, true);
  }

  // The record says how each signer signed.
  const signedEvents = await database.query<{
    metadata: { providerSignature?: Record<string, unknown> };
  }>(
    `select metadata from audit_events where envelope_id = $1 and event = 'signed' order by sequence`,
    [draft.envelopeId],
  );

  assert.equal(signedEvents.rows.length, 2);

  for (const [index, row] of signedEvents.rows.entries()) {
    assert.equal(row.metadata.providerSignature?.level, "qualified");
    assert.equal(row.metadata.providerSignature?.provider, "eID Easy");
    assert.equal(row.metadata.providerSignature?.method, "smart-id-signature");
    assert.match(
      String(row.metadata.providerSignature?.certificateSubject),
      index === 0 ? /Riley Recipient/ : /Casey Second/,
    );
  }

  assert.equal((await verifyAuditChain(draft.envelopeId, database)).ok, true);

  const detail = await getEnvelopeDetailDataForUser(
    draft.userId,
    draft.envelopeId,
    database,
  );

  assert.equal(
    detail?.signatureTypeLabel,
    "Qualified electronic signatures through eID Easy",
  );
  assert.ok(
    detail?.timeline.some(
      (item) =>
        item.description ===
        "Signed by Riley Recipient with a qualified electronic signature through eID Easy",
    ),
    JSON.stringify(detail?.timeline.map((item) => item.description)),
  );

  // Poppler finds both signatures valid, where it is installed.
  try {
    await run("pdfsig", ["-v"]);
  } catch {
    t.diagnostic("pdfsig is not installed; skipped the poppler check");
    return;
  }

  const file = path.join(storageDir, "signed.pdf");

  await writeFile(file, signedPdf);

  const { stdout } = await run("pdfsig", ["-nocert", file]).catch(
    (error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
  );

  assert.equal(
    stdout.match(/Signature Validation: Signature is Valid\./g)?.length,
    2,
    stdout,
  );
});

test("a signer who does not finish at the provider can try again", async () => {
  const draft = await createDraft();

  await send(draft, "advanced");

  const token = await linkFor(draft.riley.id);

  standIns.state.signerCancels = true;

  try {
    const cancelled = await signAtProvider(token, draft.riley);

    await assert.rejects(
      cancelled.finish(),
      (error: unknown) =>
        error instanceof ProviderSigningError &&
        error.token === token &&
        error.problem !== "expired",
    );
  } finally {
    standIns.state.signerCancels = false;
  }

  const failed = await database.query<{ revision_key: string }>(
    `select revision_key from provider_signing_sessions where envelope_id = $1`,
    [draft.envelopeId],
  );

  assert.deepEqual(await sessionStates(draft.envelopeId), ["failed"]);
  assert.equal(await stored(failed.rows[0]!.revision_key), false);

  const signer = await database.query<{ status: string }>(
    `select status from signers where id = $1`,
    [draft.riley.id],
  );

  assert.equal(signer.rows[0]?.status, "notified");

  // A second try works, and a trip started before it can no longer finish.
  const abandoned = await signAtProvider(token, draft.riley);
  const retry = await signAtProvider(token, draft.riley);

  await assert.rejects(
    abandoned.finish(),
    (error: unknown) =>
      error instanceof ProviderSigningError && error.problem === "expired",
  );
  await retry.finish();

  assert.deepEqual(await sessionStates(draft.envelopeId), [
    "completed",
    "failed",
    "failed",
  ]);

  const envelope = await database.query<{ revision_key: string | null }>(
    `select revision_key from envelopes where id = $1`,
    [draft.envelopeId],
  );

  assert.ok(envelope.rows[0]?.revision_key);
});

test("a return while another is saving the signature leaves that one to finish", async () => {
  const draft = await createDraft();

  await send(draft, "advanced");

  const riley = await signAtProvider(
    await linkFor(draft.riley.id),
    draft.riley,
  );
  const sessionId = riley.query.get("state") ?? "";
  const session = await database.query<{ revision_key: string }>(
    `select revision_key from provider_signing_sessions where id = $1`,
    [sessionId],
  );

  // Another return claimed the session first and is saving it.
  await database.query(
    `update provider_signing_sessions set state = 'signing' where id = $1`,
    [sessionId],
  );

  await assert.rejects(
    riley.finish(),
    (error: unknown) =>
      error instanceof ProviderSigningError && error.problem === "expired",
  );
  assert.deepEqual(await sessionStates(draft.envelopeId), ["signing"]);
  assert.equal(await stored(session.rows[0]!.revision_key), true);
});

test("the next signer's turn starts when the signer is back from the provider", async () => {
  const draft = await createDraft();

  await send(draft, "advanced");

  const riley = await signAtProvider(
    await linkFor(draft.riley.id),
    draft.riley,
  );
  const left = await database.query<{ submitted_at: string }>(
    `select submitted_at from provider_signing_sessions where id = $1`,
    [riley.query.get("state") ?? ""],
  );
  const leftAt = Number(left.rows[0]!.submitted_at);

  // The signer takes a while at the provider.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const backAt = Math.floor(Date.now() / 1000);

  await riley.finish();

  const signers = await database.query<{
    id: string;
    last_notified_at: string | null;
    signed_at: string | null;
    turn_started_at: string | null;
  }>(
    `select id, signed_at, turn_started_at, last_notified_at from signers where envelope_id = $1`,
    [draft.envelopeId],
  );
  const rileyRow = signers.rows.find((row) => row.id === draft.riley.id)!;
  const caseyRow = signers.rows.find((row) => row.id === draft.casey.id)!;

  // Riley signed when the signed revision says, before leaving.
  assert.equal(Number(rileyRow.signed_at), leftAt);
  assert.ok(leftAt < backAt);
  // Casey's turn, and the invitation, start once Riley is back.
  assert.ok(Number(caseyRow.turn_started_at) >= backAt);
  assert.ok(Number(caseyRow.last_notified_at) >= backAt);
});

test("an ended session keeps no secrets, and the daily cleanup ends abandoned ones", async () => {
  const draft = await createDraft();

  await send(draft, "advanced");

  const token = await linkFor(draft.riley.id);
  // Riley goes to the provider and does not come back.
  const abandoned = await signAtProvider(token, draft.riley);
  const abandonedId = abandoned.query.get("state") ?? "";
  const session = async () =>
    (
      await database.query<{
        expires_at: string;
        revision_key: string;
        secret_data: string;
        state: string;
      }>(
        `select expires_at, revision_key, secret_data, state from provider_signing_sessions where id = $1`,
        [abandonedId],
      )
    ).rows[0]!;
  const before = await session();
  const expiresAt = Number(before.expires_at);

  // Until it expires, the cleanup leaves it alone.
  await runRetentionSweep({ database, now: expiresAt - 1, storageService });
  assert.equal((await session()).state, "pending");
  assert.equal(await stored(before.revision_key), true);

  const summary = await runRetentionSweep({
    database,
    now: expiresAt,
    storageService,
  });
  const after = await session();

  assert.ok(summary.providerSigningSessionsEnded >= 1);
  assert.equal(after.state, "failed");
  assert.equal(after.secret_data, "");
  assert.equal(await stored(before.revision_key), false);

  // A session that finishes keeps none either.
  const retry = await signAtProvider(token, draft.riley);

  await retry.finish();

  const rows = await database.query<{ secret_data: string; state: string }>(
    `select secret_data, state from provider_signing_sessions where envelope_id = $1`,
    [draft.envelopeId],
  );

  assert.deepEqual(
    rows.rows.map((row) => row.secret_data),
    ["", ""],
  );
});

test("two submissions by the last signer at once finish the envelope once, and keep its files", async () => {
  const draft = await createDraft();

  await send(draft, "simple");
  await submitSigningForToken(
    await linkFor(draft.riley.id),
    submissionFor(draft.riley),
    { database, storageService },
  );

  // Casey presses Finish twice.
  const caseyToken = await linkFor(draft.casey.id);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      submitSigningForToken(caseyToken, submissionFor(draft.casey), {
        database,
        storageService,
      }),
    ),
  );

  assert.deepEqual(results.map((result) => result.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  assert.ok(
    results.some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof SigningMutationError,
    ),
  );

  const finished = (
    await database.query<{
      evidence_key: string;
      signed_pdf_key: string;
      status: string;
    }>(
      `select evidence_key, signed_pdf_key, status from envelopes where id = $1`,
      [draft.envelopeId],
    )
  ).rows[0]!;

  assert.equal(finished.status, "completed");

  // The submission that lost deleted none of the files the other saved.
  for (const key of [
    finished.signed_pdf_key,
    finished.evidence_key,
    getRecipientCertificateKey(finished.evidence_key),
  ]) {
    assert.equal(await stored(key), true, key);
  }
});

test("the last signature needs no second connection while it holds the envelope", async () => {
  // A pool of one connection: anything that needed another one while the
  // envelope is locked would wait for it, and give up after 3 seconds.
  const single = new pg.Pool({
    connectionString: (database as unknown as { options: pg.PoolConfig })
      .options.connectionString,
    connectionTimeoutMillis: 3000,
    max: 1,
  });
  const draft = await createDraft();
  // What the code reads without being handed a pool (the install's name,
  // the seal key) comes from this one too.
  const replaced = replaceDbPoolForTests(single);

  try {
    await send(draft, "simple");
    await submitSigningForToken(
      await linkFor(draft.riley.id),
      submissionFor(draft.riley),
      { database: single, storageService },
    );

    const caseyToken = await linkFor(draft.casey.id);

    // Nothing the seal reads from the database is cached.
    invalidateSettingsCache();
    resetSealIdentityCache();

    await submitSigningForToken(caseyToken, submissionFor(draft.casey), {
      database: single,
      storageService,
    });

    const finished = await database.query<{ status: string }>(
      `select status from envelopes where id = $1`,
      [draft.envelopeId],
    );

    assert.equal(finished.rows[0]!.status, "completed");
  } finally {
    replaceDbPoolForTests(replaced ?? database);
    await single.end();
  }
});

test("a revision the cleanup cannot delete is tried again, and the current one is kept", async () => {
  const draft = await createDraft();

  await send(draft, "advanced");

  const rileyToken = await linkFor(draft.riley.id);
  const abandoned = await signAtProvider(rileyToken, draft.riley);
  const sessionRow = async (id: string) =>
    (
      await database.query<{
        expires_at: string;
        revision_key: string;
        state: string;
      }>(
        `select expires_at, revision_key, state from provider_signing_sessions where id = $1`,
        [id],
      )
    ).rows[0]!;
  const abandonedId = abandoned.query.get("state") ?? "";
  const abandonedBefore = await sessionRow(abandonedId);
  const expiresAt = Number(abandonedBefore.expires_at);
  // Storage refuses to delete the abandoned session's revision, once.
  const failingStorage: StorageService = {
    ...storageService,
    deleteObject: async (key) => {
      if (key === abandonedBefore.revision_key) {
        throw new Error("Storage is unavailable.");
      }

      await storageService.deleteObject(key);
    },
  };

  await runRetentionSweep({
    database,
    now: expiresAt,
    storageService: failingStorage,
  });

  // Ended, but the revision and the key that finds it are both kept.
  assert.equal((await sessionRow(abandonedId)).state, "failed");
  assert.equal(
    (await sessionRow(abandonedId)).revision_key,
    abandonedBefore.revision_key,
  );
  assert.equal(await stored(abandonedBefore.revision_key), true);

  await runRetentionSweep({ database, now: expiresAt, storageService });

  assert.equal((await sessionRow(abandonedId)).revision_key, "");
  assert.equal(await stored(abandonedBefore.revision_key), false);

  // Riley and Casey sign. Riley's revision is deleted once Casey's replaces
  // it; here that delete is taken to have failed, so the file is back.
  const riley = await signAtProvider(rileyToken, draft.riley);

  await riley.finish();

  const rileyRevision = await sessionRow(riley.query.get("state") ?? "");
  const rileyBytes = (
    await storageService.getObject(rileyRevision.revision_key)
  ).body;
  const casey = await signAtProvider(
    await linkFor(draft.casey.id),
    draft.casey,
  );

  await casey.finish();
  await storageService.putObject({
    body: rileyBytes,
    contentType: "application/pdf",
    key: rileyRevision.revision_key,
  });

  const caseyRevision = await sessionRow(casey.query.get("state") ?? "");

  await runRetentionSweep({ database, now: expiresAt, storageService });

  // The replaced revision goes, the envelope's current one stays.
  assert.equal(
    (await sessionRow(riley.query.get("state") ?? "")).revision_key,
    "",
  );
  assert.equal(await stored(rileyRevision.revision_key), false);
  assert.equal(
    (await sessionRow(casey.query.get("state") ?? "")).revision_key,
    caseyRevision.revision_key,
  );
  assert.equal(await stored(caseyRevision.revision_key), true);
});

test("a certificate in someone else's name does not sign for the invited signer", async () => {
  const draft = await createDraft();

  await send(draft, "qualified");

  const token = await linkFor(draft.riley.id);
  // Someone holding Riley's link signs in at the provider as themselves.
  const other = await signAtProvider(token, draft.riley, {
    as: "Morgan Other",
  });

  await assert.rejects(
    other.finish(),
    (error: unknown) =>
      error instanceof ProviderSigningError &&
      error.problem === "name" &&
      error.token === token &&
      /Morgan Other/.test(error.message),
  );
  assert.deepEqual(await sessionStates(draft.envelopeId), ["failed"]);

  const signer = await database.query<{ status: string }>(
    `select status from signers where id = $1`,
    [draft.riley.id],
  );

  assert.equal(signer.rows[0]?.status, "notified");

  // Riley, in their own name, can still sign.
  await (await signAtProvider(token, draft.riley)).finish();
  assert.deepEqual(await sessionStates(draft.envelopeId), [
    "completed",
    "failed",
  ]);
});
