import { SIGNUDOC_NAME, type Branding } from "../branding.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";
import { escapeHtml } from "../utils/html.ts";
import { requireConfigValue } from "./service-config.ts";

type EmailBodyContent = {
  htmlBody: string;
  textBody: string;
};

type FooterLink = {
  label: string;
  url: string;
};

// Links may be pages on this site ("/terms") or the organization's own
// absolute URLs. Either way the email gets an absolute URL.
function buildFooterLinks(branding: Branding, env: EnvSource): FooterLink[] {
  const candidates: Array<[label: string, url: string | null]> = [
    ["Terms of Service", branding.termsUrl],
    // Without the organization's own policy, the notice built from the
    // install's settings.
    branding.privacyUrl || branding.hosted
      ? ["Privacy Policy", branding.privacyUrl]
      : ["Privacy notice", getEnv(env).appUrl ? "/signer-privacy" : null],
    ["Contact", branding.contactUrl],
  ];
  const links = candidates.filter((candidate): candidate is [string, string] =>
    Boolean(candidate[1]),
  );

  if (links.length === 0) {
    return [];
  }

  const appUrl = requireConfigValue("app", "APP_URL", getEnv(env).appUrl);

  return links.map(([label, url]) => ({
    label,
    url: new URL(url, appUrl).toString(),
  }));
}

/**
 * The install's logo for the top of an email, or nothing when it has none.
 * Email programs fetch it from this site, so it needs the site's address;
 * many hide pictures until asked, which is why the name is the alt text.
 */
function buildLogoHeader(branding: Branding, env: EnvSource): string {
  const appUrl = getEnv(env).appUrl;

  if (!branding.logoUrl || !appUrl) {
    return "";
  }

  const source = new URL(branding.logoUrl, appUrl).toString();

  return [
    '<p style="margin:0 0 24px;">',
    `<img src="${escapeHtml(source)}" alt="${escapeHtml(branding.productName)}" height="40" `,
    'style="display:block;height:40px;width:auto;max-width:240px;border:0;" />',
    "</p>",
  ].join("");
}

/**
 * Appends the footer every email to a person carries: the install's terms,
 * privacy and contact links, where it has them. On a neutral install the
 * footer also names the organization's support address and says the message
 * was sent with SignuDoc, and the organization's logo, when it has one,
 * goes at the top.
 */
export function withUserEmailLegalFooter(
  input: EmailBodyContent,
  branding: Branding,
  env: EnvSource = process.env,
): EmailBodyContent {
  const links = buildFooterLinks(branding, env);
  const logoHeader = buildLogoHeader(branding, env);
  const textLines: string[] = [];
  const htmlLines: string[] = [];

  for (const link of links) {
    textLines.push("", `${link.label}:`, link.url);
    htmlLines.push(`<a href="${escapeHtml(link.url)}">${link.label}</a>`);
  }

  if (!branding.hosted) {
    if (branding.supportAddress) {
      textLines.push("", `Questions? Contact ${branding.supportAddress}.`);
      htmlLines.push(
        `Questions? Contact <a href="mailto:${escapeHtml(branding.supportAddress)}">${escapeHtml(branding.supportAddress)}</a>.`,
      );
    }

    const sentBy = branding.organizationName
      ? `Sent by ${branding.organizationName} using ${SIGNUDOC_NAME}.`
      : `Sent using ${SIGNUDOC_NAME}.`;

    textLines.push("", sentBy);
    htmlLines.push(escapeHtml(sentBy));
  }

  if (htmlLines.length === 0) {
    return logoHeader
      ? { htmlBody: `${logoHeader}${input.htmlBody}`, textBody: input.textBody }
      : input;
  }

  const htmlFooter = [
    '<hr style="margin:24px 0;border:none;border-top:1px solid #e2e2e2;" />',
    `<p>${htmlLines.join("<br />")}</p>`,
  ].join("");

  return {
    htmlBody: `${logoHeader}${input.htmlBody}${htmlFooter}`,
    // Each entry starts with an empty line; one more newline puts that
    // empty line between the message and the footer.
    textBody: `${input.textBody}\n${textLines.join("\n")}`,
  };
}
