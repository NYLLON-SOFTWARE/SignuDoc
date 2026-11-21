import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveProviderReturnUrl } from "./provider-return-redirect.ts";

const requestUrl = "http://0.0.0.0:3000/api/signing/provider/return?state=test";
const publicEnv = {
  APP_URL: "http://localhost:3118",
  NODE_ENV: "production",
};

test("provider completion redirects to the configured public origin", () => {
  const location = resolveProviderReturnUrl(
    "/sign/test-token/done",
    requestUrl,
    publicEnv,
  );

  assert.equal(location.href, "http://localhost:3118/sign/test-token/done");
});

test("provider errors return signers to the configured public origin", () => {
  const location = resolveProviderReturnUrl(
    "/sign/test-token?signatureProblem=cancelled",
    requestUrl,
    publicEnv,
  );

  assert.equal(
    location.href,
    "http://localhost:3118/sign/test-token?signatureProblem=cancelled",
  );
});

test("an absolute provider continuation keeps its destination", () => {
  const providerUrl = "https://provider.example.org/continue?session=test";
  const location = resolveProviderReturnUrl(providerUrl, requestUrl, publicEnv);

  assert.equal(location.href, providerUrl);
});

test("provider redirects fall back to the request origin without a public URL", () => {
  const location = resolveProviderReturnUrl(
    "/sign/test-token/done",
    "http://localhost:3000/api/signing/provider/return?state=test",
    {},
  );

  assert.equal(location.href, "http://localhost:3000/sign/test-token/done");
});
