// Who may create an account on this install. Signers never need an account,
// so none of this affects people who are only sent a document to sign.

export const SIGNUP_MODES = ["closed", "domains", "open"] as const;

export type SignupMode = (typeof SIGNUP_MODES)[number];

export type SignupPolicy = {
  allowedEmailDomains: readonly string[];
  signupMode: SignupMode;
};

export type SignupDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "signup_closed" | "signup_domain_not_allowed";
      message: string;
    };

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Mailbox providers anyone can get an address at. An administrator who signs
// up with one of these does not get "everyone at my domain may join" as the
// starting rule, because that would mean everyone on the internet.
const PUBLIC_MAILBOX_DOMAINS = new Set([
  "aol.com",
  "duck.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "tuta.com",
  "tutanota.com",
  "yahoo.com",
  "yandex.com",
  "ymail.com",
  "zoho.com",
]);

/** "@Acme.com " becomes "acme.com". Returns null for anything that is not a domain. */
export function normalizeEmailDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^@/, "");

  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

export function getEmailDomain(email: string): string | null {
  const separatorIndex = email.lastIndexOf("@");

  if (separatorIndex <= 0) {
    return null;
  }

  return normalizeEmailDomain(email.slice(separatorIndex + 1));
}

export function isPublicMailboxDomain(domain: string): boolean {
  return PUBLIC_MAILBOX_DOMAINS.has(domain.trim().toLowerCase());
}

/**
 * Splits what an administrator typed ("acme.com, @acme.co.uk") into a clean
 * list. Entries that are not domains are returned separately so the form can
 * point at them.
 */
export function parseEmailDomainList(value: string | readonly string[]): {
  domains: string[];
  invalid: string[];
} {
  const entries = (typeof value === "string" ? value.split(/[\s,;]+/) : value)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const domains = new Set<string>();
  const invalid: string[] = [];

  for (const entry of entries) {
    const domain = normalizeEmailDomain(entry);

    if (domain) {
      domains.add(domain);
    } else {
      invalid.push(entry);
    }
  }

  return { domains: Array.from(domains).sort(), invalid };
}

/** The rule a new install starts with, taken from the administrator's own address. */
export function suggestSignupPolicy(adminEmail: string): SignupPolicy {
  const domain = getEmailDomain(adminEmail);

  if (!domain || isPublicMailboxDomain(domain)) {
    return { allowedEmailDomains: [], signupMode: "closed" };
  }

  return { allowedEmailDomains: [domain], signupMode: "domains" };
}

export function describeSignupPolicy(policy: SignupPolicy): string {
  if (policy.signupMode === "open") {
    return "Anyone can create an account.";
  }

  if (
    policy.signupMode === "domains" &&
    policy.allowedEmailDomains.length > 0
  ) {
    return `Accounts can be created with an email address at ${formatDomainList(policy.allowedEmailDomains)}.`;
  }

  return "New accounts are not being accepted.";
}

function formatDomainList(domains: readonly string[]): string {
  const labels = domains.map((domain) => `@${domain}`);

  if (labels.length <= 1) {
    return labels[0] ?? "";
  }

  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

export function evaluateSignup(
  email: string,
  policy: SignupPolicy,
): SignupDecision {
  if (policy.signupMode === "open") {
    return { allowed: true };
  }

  if (policy.signupMode === "domains") {
    const domain = getEmailDomain(email);

    if (domain && policy.allowedEmailDomains.includes(domain)) {
      return { allowed: true };
    }

    if (policy.allowedEmailDomains.length > 0) {
      return {
        allowed: false,
        code: "signup_domain_not_allowed",
        message: describeSignupPolicy(policy),
      };
    }
  }

  return {
    allowed: false,
    code: "signup_closed",
    message: "New accounts are not being accepted.",
  };
}
