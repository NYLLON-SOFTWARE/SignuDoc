import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { startTestPki } from "./pki-test-support.ts";
import {
  followSigner,
  STAND_IN_CLIENT,
  startProviderStandIns,
  type ProviderStandIns,
} from "./signing-provider-test-support.ts";
import {
  configuredSigningProvider,
  createCscProvider,
  createEidEasyProvider,
  SigningProviderError,
  signingProviderById,
  type SigningProvider,
} from "./signing-providers.ts";
import { checkSignerSignature } from "./signer-cms.ts";

const RETURN_URL = "https://sign.example.org/api/signing/provider/return";
const digest = createHash("sha256").update("revision bytes").digest();

async function withStandIns(
  body: (standIns: ProviderStandIns) => Promise<void>,
) {
  const pki = await startTestPki();
  const signer = pki.issueSigner({
    commonName: "Alice Example",
    qualified: true,
  });
  const standIns = await startProviderStandIns({
    chain: [signer.certificate, pki.caCertificate],
    privateKeyPem: signer.privateKeyPem,
  });

  try {
    await body(standIns);
  } finally {
    await standIns.close();
    await pki.close();
  }
}

/** Runs a provider's whole flow, following each redirect as a browser. */
async function signWith(provider: SigningProvider) {
  const started = await provider.start({
    contentDigest: digest,
    documentName: "Supply agreement / 2026",
    level: "qualified",
    returnUrl: RETURN_URL,
    signer: { email: "alice@example.org", name: "Alice Example" },
    state: "session-1",
  });
  let data = started.data;
  let redirectUrl = started.redirectUrl;

  for (let step = 0; step < 4; step += 1) {
    const query = await followSigner(redirectUrl);

    assert.equal(query.get("state"), "session-1");

    const next = await provider.resume({
      contentDigest: digest,
      data,
      query,
      returnUrl: RETURN_URL,
      state: "session-1",
    });

    if (next.kind === "signed") {
      return { cms: next.cms, method: next.method, steps: step + 1 };
    }

    data = next.data;
    redirectUrl = next.redirectUrl;
  }

  throw new Error("Too many steps.");
}

test("eID Easy signs the revision's hash in one redirect", async () => {
  await withStandIns(async (standIns) => {
    const provider = createEidEasyProvider({
      apiUrl: standIns.eidEasyUrl,
      clientId: STAND_IN_CLIENT.id,
      secret: STAND_IN_CLIENT.secret,
    });
    const signed = await signWith(provider);
    const checked = checkSignerSignature(signed.cms, digest, {
      level: "qualified",
    });

    assert.equal(signed.steps, 1);
    assert.equal(signed.method, "smart-id-signature");
    assert.equal(checked.qualified, true);
    assert.match(checked.subject, /Alice Example/);
  });
});

test("a signer who cancels at eID Easy gets no signature", async () => {
  await withStandIns(async (standIns) => {
    standIns.state.signerCancels = true;

    await assert.rejects(
      signWith(
        createEidEasyProvider({
          apiUrl: standIns.eidEasyUrl,
          clientId: STAND_IN_CLIENT.id,
          secret: STAND_IN_CLIENT.secret,
        }),
      ),
      (error: unknown) =>
        error instanceof SigningProviderError &&
        /no signature for this document/.test(error.message),
    );
  });
});

test("wrong eID Easy credentials are reported", async () => {
  await withStandIns(async (standIns) => {
    await assert.rejects(
      createEidEasyProvider({
        apiUrl: standIns.eidEasyUrl,
        clientId: STAND_IN_CLIENT.id,
        secret: "wrong",
      }).start({
        contentDigest: digest,
        documentName: "x",
        level: "advanced",
        returnUrl: RETURN_URL,
        signer: { email: "a@example.org", name: "A" },
        state: "s",
      }),
      /eID Easy failed: Unknown client/,
    );
  });
});

test("a CSC provider signs after the signer chooses a certificate and authorizes the hash", async () => {
  await withStandIns(async (standIns) => {
    const provider = createCscProvider({
      apiUrl: standIns.cscUrl,
      clientId: STAND_IN_CLIENT.id,
      clientSecret: STAND_IN_CLIENT.secret,
      name: "Test QTSP",
    });
    const signed = await signWith(provider);
    const checked = checkSignerSignature(signed.cms, digest, {
      level: "qualified",
    });

    assert.equal(signed.steps, 2);
    assert.equal(checked.qualified, true);
    // The second sign-in authorized one signature of one hash.
    assert.equal(standIns.state.lastAuthorize?.get("scope"), "credential");
    assert.equal(standIns.state.lastAuthorize?.get("numSignatures"), "1");
    assert.equal(standIns.state.refusedHashes, 0);
  });
});

test("a signer who cancels at the CSC provider is told where it stopped", async () => {
  await withStandIns(async (standIns) => {
    standIns.state.signerCancels = true;

    await assert.rejects(
      signWith(
        createCscProvider({
          apiUrl: standIns.cscUrl,
          clientId: STAND_IN_CLIENT.id,
          clientSecret: STAND_IN_CLIENT.secret,
          name: "Test QTSP",
        }),
      ),
      /Signing at Test QTSP did not finish \(The user cancelled\)/,
    );
  });
});

test("the provider comes from the environment", () => {
  assert.equal(configuredSigningProvider({}), null);
  assert.equal(
    configuredSigningProvider({
      EIDEASY_CLIENT_ID: "id",
      EIDEASY_SECRET: "secret",
    })?.id,
    "eideasy",
  );

  const both = {
    CSC_API_URL: "https://qtsp.example/csc/v2",
    CSC_CLIENT_ID: "id",
    CSC_CLIENT_SECRET: "secret",
    CSC_PROVIDER_NAME: "Example QTSP",
    EIDEASY_CLIENT_ID: "id",
    EIDEASY_SECRET: "secret",
    SIGNING_PROVIDER: "csc",
  };

  assert.equal(configuredSigningProvider(both)?.name, "Example QTSP");
  // An envelope sent with the other provider can still finish.
  assert.equal(signingProviderById("eideasy", both)?.id, "eideasy");
  assert.equal(signingProviderById("csc", {}), null);
});
