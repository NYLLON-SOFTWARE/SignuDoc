import {
  getEmailDomain,
  isPublicMailboxDomain,
  normalizeEmailDomain,
} from "./signup-policy.ts";

// Where this site's email is sent from, as setup offers it.
//
// Mail is sent through Resend, which only sends from a domain whose DNS
// records prove it belongs to you. Setup does not ask for that address
// blind: it guesses the organization's domain from what it already knows
// (the site's own address, the administrator's email, the support email),
// and puts a subdomain in front of it, "sign." unless the administrator
// picks another or none.
//
// A subdomain is what Resend recommends. Its records (DKIM at
// resend._domainkey.sign.acme.com, SPF and the bounce MX at
// send.sign.acme.com) sit apart from whatever already sends mail for
// acme.com, and its sending reputation is its own.
// https://resend.com/docs/knowledge-base/is-it-better-to-send-emails-from-a-subdomain-or-the-root-domain

export const DEFAULT_SENDING_SUBDOMAIN = "sign";
export const DEFAULT_SENDER_LOCAL_PART = "notifications";

// Hosts that can never be a sending domain of the organization's own: the
// platform's shared domains, Resend's test domain and local names.
const SHARED_HOST_SUFFIXES = [
  "vercel.app",
  "vercel.dev",
  "now.sh",
  "resend.dev",
  "localhost",
  "local",
  "internal",
  "test",
  "example",
  "invalid",
];

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

function isSharedHost(domain: string): boolean {
  return SHARED_HOST_SUFFIXES.some(
    (suffix) => domain === suffix || domain.endsWith(`.${suffix}`),
  );
}

/**
 * A domain the organization could own and verify with Resend: a real
 * domain, not a public mailbox provider's and not a platform's shared one.
 */
export function isOwnableDomain(value: string): boolean {
  const domain = normalizeEmailDomain(value);

  return (
    domain !== null &&
    domain.includes(".") &&
    !isPublicMailboxDomain(domain) &&
    !isSharedHost(domain) &&
    !/^\d+(?:\.\d+){3}$/.test(domain)
  );
}

type SuggestionInput = {
  /** Email addresses typed into setup so far, most telling first. */
  emails?: readonly (string | null | undefined)[];
  /** The host the site answers on, such as sign.acme.com or acme.vercel.app. */
  siteHost?: string | null;
};

/**
 * The organization's own domain, as far as setup can tell, or null.
 *
 * The site's host wins when it is a custom domain, cut back to the email
 * domain it sits under (esign.acme.com with jane@acme.com gives acme.com).
 * A fresh Vercel deployment answers on vercel.app, which nobody can send
 * from, so then the email addresses decide.
 */
export function suggestSendingRootDomain({
  emails = [],
  siteHost,
}: SuggestionInput): string | null {
  const emailDomains = emails
    .map((email) => (email ? getEmailDomain(email) : null))
    .filter((domain): domain is string => domain !== null)
    .filter(isOwnableDomain);
  const host = siteHost ? normalizeEmailDomain(siteHost) : null;

  if (host && isOwnableDomain(host)) {
    const parent = emailDomains.find(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );

    if (parent) {
      return parent;
    }

    // A site that already lives at sign.acme.com sends from it as is.
    const prefix = `${DEFAULT_SENDING_SUBDOMAIN}.`;

    if (host.startsWith(prefix) && isOwnableDomain(host.slice(prefix.length))) {
      return host.slice(prefix.length);
    }

    return host;
  }

  return emailDomains[0] ?? null;
}

/** "Sign." becomes "sign". Returns null for anything that is not one or more DNS labels. */
export function normalizeSubdomain(value: string): string | null {
  const subdomain = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");

  if (subdomain.length === 0) {
    return "";
  }

  return subdomain.split(".").every((label) => LABEL_PATTERN.test(label))
    ? subdomain
    : null;
}

/** The part before the @, lower-cased, or null if it will not make an address. */
export function normalizeLocalPart(value: string): string | null {
  const localPart = value.trim().toLowerCase();

  return LOCAL_PART_PATTERN.test(localPart) && !localPart.includes("..")
    ? localPart
    : null;
}

/** The domain mail is sent from: the subdomain, if any, in front of the root. */
export function joinSendingDomain(
  rootDomain: string,
  subdomain: string,
): string {
  return subdomain ? `${subdomain}.${rootDomain}` : rootDomain;
}

export type SenderAddressParts = {
  localPart: string;
  rootDomain: string;
  subdomain: string;
};

export type SenderAddressResult =
  | { address: null; error: null }
  | { address: string; error: null; sendingDomain: string }
  | {
      address: null;
      error: { field: keyof SenderAddressParts; message: string };
    };

/**
 * Puts the three parts setup asks for together into one address. An empty
 * root domain means "decide later", which is not an error.
 */
export function buildSenderAddress(
  parts: SenderAddressParts,
): SenderAddressResult {
  if (parts.rootDomain.trim().length === 0) {
    return { address: null, error: null };
  }

  const rootDomain = normalizeEmailDomain(parts.rootDomain);

  if (!rootDomain || !rootDomain.includes(".")) {
    return {
      address: null,
      error: {
        field: "rootDomain",
        message: "Enter a domain, such as acmecorp.com",
      },
    };
  }

  if (!isOwnableDomain(rootDomain)) {
    return {
      address: null,
      error: {
        field: "rootDomain",
        message: `Mail cannot be sent from ${rootDomain}. Use a domain your organization owns.`,
      },
    };
  }

  const subdomain = normalizeSubdomain(parts.subdomain);

  if (subdomain === null) {
    return {
      address: null,
      error: {
        field: "subdomain",
        message: "Use letters, numbers and hyphens, such as sign",
      },
    };
  }

  const localPart = normalizeLocalPart(parts.localPart);

  if (localPart === null) {
    return {
      address: null,
      error: {
        field: "localPart",
        message:
          "Use letters, numbers, dots and hyphens, such as notifications",
      },
    };
  }

  const sendingDomain = joinSendingDomain(rootDomain, subdomain);

  return {
    address: `${localPart}@${sendingDomain}`,
    error: null,
    sendingDomain,
  };
}

/**
 * The Resend integration on the Vercel Marketplace asks for a domain when it
 * is installed, sets it up in Resend and hands it to the project as
 * RESEND_EMAIL_DOMAIN. Setup starts from that domain as it is, since its
 * DNS records may already be in place. One that begins with "sign." is
 * shown as that subdomain of its parent, so the form reads the same way.
 */
export function readResendEmailDomain(
  value: string | null | undefined,
): SenderAddressParts | null {
  const domain = value ? normalizeEmailDomain(value) : null;

  if (!domain || !isOwnableDomain(domain)) {
    return null;
  }

  const prefix = `${DEFAULT_SENDING_SUBDOMAIN}.`;
  const parent = domain.startsWith(prefix) ? domain.slice(prefix.length) : null;

  return parent && isOwnableDomain(parent)
    ? {
        localPart: DEFAULT_SENDER_LOCAL_PART,
        rootDomain: parent,
        subdomain: DEFAULT_SENDING_SUBDOMAIN,
      }
    : {
        localPart: DEFAULT_SENDER_LOCAL_PART,
        rootDomain: domain,
        subdomain: "",
      };
}
