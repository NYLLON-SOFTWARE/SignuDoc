// Stand-ins for a signing provider, for the end-to-end test: eID Easy's
// signing API, signing with a qualified certificate from the test CA. The
// app under test is pointed at it with EIDEASY_API_URL. Runs until stopped.

import { startTestPki } from "../../src/lib/services/pki-test-support.ts";
import { startProviderStandIns } from "../../src/lib/services/signing-provider-test-support.ts";

const port = Number(process.env.E2E_PROVIDER_PORT ?? 3101);
const pki = await startTestPki();
const signer = pki.issueSigner({
  commonName: "Quinn Qualified",
  qualified: true,
});
const standIns = await startProviderStandIns(
  {
    chain: [signer.certificate, pki.caCertificate],
    privateKeyPem: signer.privateKeyPem,
  },
  { port },
);

console.log(`[provider stand-in] eID Easy at ${standIns.eidEasyUrl}`);

async function stop() {
  await standIns.close();
  await pki.close();
  process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
