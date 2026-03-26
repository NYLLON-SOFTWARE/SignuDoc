import { publicLegalLinks } from "../legal.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";
import { escapeHtml } from "../utils/html.ts";
import { assertServiceConfig } from "./service-config.ts";

const APP_URL_ENV_KEYS = ["APP_URL"] as const;

type EmailBodyContent = {
  htmlBody: string;
  textBody: string;
};

function getAbsoluteLegalLinks(env: EnvSource = process.env) {
  assertServiceConfig("app", APP_URL_ENV_KEYS, env);
  const { appUrl } = getEnv(env);

  return publicLegalLinks.map((link) => ({
    ...link,
    url: new URL(link.href, appUrl!).toString(),
  }));
}

export function withUserEmailLegalFooter(
  input: EmailBodyContent,
  env: EnvSource = process.env,
): EmailBodyContent {
  const [termsLink, privacyLink, contactLink] = getAbsoluteLegalLinks(env);
  const textFooter = [
    "",
    "Terms of Service:",
    termsLink.url,
    "",
    "Privacy Policy:",
    privacyLink.url,
    "",
    "Contact:",
    contactLink.url,
  ].join("\n");
  const htmlFooter = [
    '<hr style="margin:24px 0;border:none;border-top:1px solid #e2e2e2;" />',
    `<p><a href="${escapeHtml(termsLink.url)}">${termsLink.longLabel}</a><br /><a href="${escapeHtml(privacyLink.url)}">${privacyLink.longLabel}</a><br /><a href="${escapeHtml(contactLink.url)}">${contactLink.longLabel}</a></p>`,
  ].join("");

  return {
    htmlBody: `${input.htmlBody}${htmlFooter}`,
    textBody: `${input.textBody}${textFooter}`,
  };
}
