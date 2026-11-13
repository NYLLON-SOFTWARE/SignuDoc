import { SIGNUDOC_NAME } from "../branding.ts";

// Which addresses email is sent from and replied to.
//
// Until an organization has verified its own domain with Resend, mail goes
// out from Resend's shared testing address. Resend only delivers that mail
// to the email address of the Resend account's owner, which is enough to try
// the install but not to send documents to anyone else.
// https://resend.com/docs/knowledge-base/403-error-resend-dev-domain

export const RESEND_TEST_SENDER_ADDRESS = "onboarding@resend.dev";
export const RESEND_TEST_SENDER_DOMAIN = "resend.dev";

export type EmailAddresses = {
  /** The From header, with a display name. */
  senderAddress: string;
  /** Where replies go when a message does not say otherwise. */
  supportAddress: string | null;
};

type EmailAddressSettings = {
  hosted: boolean;
  organizationName: string | null;
  senderAddress: string | null;
  supportAddress: string | null;
};

/** "Acme <sign@acme.com>" becomes "sign@acme.com". */
export function extractEmailAddress(value: string): string {
  const match = /<([^<>]+)>\s*$/.exec(value);

  return (match?.[1] ?? value).trim().toLowerCase();
}

export function getAddressDomain(value: string): string | null {
  const address = extractEmailAddress(value);
  const separatorIndex = address.lastIndexOf("@");

  if (separatorIndex <= 0 || separatorIndex === address.length - 1) {
    return null;
  }

  return address.slice(separatorIndex + 1);
}

export function isResendTestSender(value: string): boolean {
  return getAddressDomain(value) === RESEND_TEST_SENDER_DOMAIN;
}

// A display name goes into an email header, so anything with a meaning there
// (quotes, angle brackets, separators, line breaks) is dropped.
function cleanDisplayName(value: string | null): string {
  const cleaned = (value ?? "")
    .replace(/[\u0000-\u001f\u007f"<>()[\]\\,;:@]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return cleaned || SIGNUDOC_NAME;
}

function hasDisplayName(value: string): boolean {
  return /<[^<>]+>\s*$/.test(value);
}

export function buildEmailAddresses(
  settings: EmailAddressSettings,
  fallbackSenderAddress: string = RESEND_TEST_SENDER_ADDRESS,
): EmailAddresses {
  const configuredSender = settings.senderAddress?.trim() || null;
  const displayName = cleanDisplayName(
    settings.hosted ? SIGNUDOC_NAME : settings.organizationName,
  );
  let senderAddress: string;

  if (configuredSender && hasDisplayName(configuredSender)) {
    senderAddress = configuredSender;
  } else {
    senderAddress = `${displayName} <${configuredSender ?? fallbackSenderAddress}>`;
  }

  return {
    senderAddress,
    supportAddress: settings.supportAddress?.trim() || null,
  };
}
