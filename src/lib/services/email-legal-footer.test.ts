import assert from "node:assert/strict";
import { test } from "node:test";

import { HOSTED_BRANDING, type Branding } from "../branding.ts";
import { withUserEmailLegalFooter } from "./email-legal-footer.ts";

const env = { APP_URL: "https://sign.acme.com" };
const body = { htmlBody: "<p>Hello</p>", textBody: "Hello" };

const neutral: Branding = {
  contactUrl: null,
  hosted: false,
  organizationName: "Acme Corp",
  privacyUrl: null,
  productName: "Acme Corp",
  signupAvailable: true,
  supportAddress: null,
  termsUrl: null,
};

test("the hosted service links to its own terms, privacy and contact pages", () => {
  const result = withUserEmailLegalFooter(body, HOSTED_BRANDING, env);

  assert.equal(
    result.textBody,
    [
      "Hello",
      "",
      "Terms of Service:",
      "https://sign.acme.com/terms",
      "",
      "Privacy Policy:",
      "https://sign.acme.com/privacy",
      "",
      "Contact:",
      "https://sign.acme.com/contact",
    ].join("\n"),
  );
  assert.match(
    result.htmlBody,
    /<a href="https:\/\/sign\.acme\.com\/terms">Terms of Service<\/a>/,
  );
  assert.doesNotMatch(result.textBody, /Sent by|Sent using/);
});

test("a neutral install with nothing else set links its signer privacy notice and says who sent the message", () => {
  const result = withUserEmailLegalFooter(body, neutral, env);

  assert.equal(
    result.textBody,
    [
      "Hello",
      "",
      "Privacy notice:",
      "https://sign.acme.com/signer-privacy",
      "",
      "Sent by Acme Corp using SignuDoc.",
    ].join("\n"),
  );
});

test("a neutral install links to the organization's own pages and support address", () => {
  const result = withUserEmailLegalFooter(
    body,
    {
      ...neutral,
      privacyUrl: "https://acme.com/privacy",
      supportAddress: "help@acme.com",
      termsUrl: "https://acme.com/terms",
    },
    env,
  );

  assert.equal(
    result.textBody,
    [
      "Hello",
      "",
      "Terms of Service:",
      "https://acme.com/terms",
      "",
      "Privacy Policy:",
      "https://acme.com/privacy",
      "",
      "Questions? Contact help@acme.com.",
      "",
      "Sent by Acme Corp using SignuDoc.",
    ].join("\n"),
  );
  assert.match(
    result.htmlBody,
    /<a href="mailto:help@acme\.com">help@acme\.com<\/a>/,
  );
});

test("an install that has not been named yet does not invent a name", () => {
  const result = withUserEmailLegalFooter(
    body,
    { ...neutral, organizationName: null, productName: "SignuDoc" },
    env,
  );

  assert.match(result.textBody, /\n\nSent using SignuDoc\.$/);
  assert.doesNotMatch(result.textBody, /Acme/);
});

test("the organization's name and links are escaped in the HTML part", () => {
  const result = withUserEmailLegalFooter(
    body,
    {
      ...neutral,
      organizationName: "Harbour & <Finch>",
      termsUrl: 'https://acme.com/terms?a=1&b="2"',
    },
    env,
  );

  assert.match(result.htmlBody, /Sent by Harbour &amp; &lt;Finch&gt; using/);
  assert.doesNotMatch(result.htmlBody, /<Finch>/);
  assert.doesNotMatch(result.htmlBody, /b="2"/);
  // The plain-text part is not HTML and carries the name as it is.
  assert.match(result.textBody, /Sent by Harbour & <Finch> using SignuDoc\./);
});

test("a neutral install with no links does not need to know its own URL", () => {
  assert.doesNotThrow(() => withUserEmailLegalFooter(body, neutral, {}));
});
