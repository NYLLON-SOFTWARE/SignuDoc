import { Resend } from "resend";

import {
  buildEmailAddresses,
  extractEmailAddress,
  getAddressDomain,
  isResendTestSender,
} from "./services/email-addresses.ts";
import { resolveEmailDriver } from "./services/email.ts";
import {
  getSettings,
  markEmailReady,
  type ResolvedSettings,
} from "./settings.ts";
import { getEnv, type EnvSource } from "./utils/env.ts";

// Whether this install can send email to anyone, and what is left to do if
// it cannot. Shown to the administrator in Settings.
//
// Sending from an organization's own address needs that address's domain to
// be verified with Resend, which means adding DNS records. Resend's API can
// add the domain and hand back the records, so the app can show them itself.
// A Resend API key that is only allowed to send cannot do that; then the
// administrator is pointed at Resend's dashboard instead.
// https://resend.com/docs/api-reference/domains/create-domain

export const RESEND_DOMAINS_URL = "https://resend.com/domains";

export type EmailDnsRecord = {
  name: string;
  priority: number | null;
  purpose: string;
  status: string;
  type: string;
  value: string;
};

export type EmailStatus =
  /** Development: messages are written to disk, not sent. */
  | { state: "capture" }
  /** No Resend API key, so nothing can be sent. */
  | { state: "missing_key" }
  /** Sending from Resend's shared test address: only reaches the Resend account owner. */
  | { state: "test_sender"; senderAddress: string }
  /** The API key can send, but is not allowed to look at domains. */
  | { state: "restricted_key"; domain: string; senderAddress: string }
  /** The sender's domain has not been added to the Resend account. */
  | { state: "domain_missing"; domain: string; senderAddress: string }
  /** The domain is in Resend but its DNS records have not been verified. */
  | {
      state: "domain_pending";
      domain: string;
      /**
       * Set when Resend has verified part of the domain and the records do
       * not say whether sending is the part that works. Only a test email
       * can tell then.
       */
      mayAlreadySend?: true;
      records: EmailDnsRecord[];
      senderAddress: string;
    }
  | { state: "ready"; domain: string; senderAddress: string }
  | { state: "error"; message: string; senderAddress: string };

/** The parts of the Resend SDK used here. Replaced by a fake in tests. */
export type ResendDomainsClient = Pick<
  Resend["domains"],
  "create" | "get" | "list" | "verify"
>;

type EmailStatusOptions = {
  domainsClient?: ResendDomainsClient;
  env?: EnvSource;
  /** Replaced in tests, where there is no database to write the result to. */
  recordReady?: (ready: boolean) => Promise<void>;
  settings?: ResolvedSettings;
};

// Whether Resend refused because this key is not allowed to look at
// domains, as opposed to refusing for any other reason. Told apart by name:
// a 401 or 403 is also what a mistyped or suspended key gets, and what
// adding a domain that another Resend account already has gets, and those
// come with a message of their own that is worth showing.
// https://resend.com/docs/api-reference/errors
function isRestrictedKeyError(error: {
  name?: string;
  statusCode?: number | null;
}): boolean {
  if (error.name === "invalid_access" || error.name === "invalid_permission") {
    return true;
  }

  // Resend uses this name twice: with 401 for a key that may only send,
  // and with 403 for a key that has been switched off.
  return error.name === "restricted_api_key" && error.statusCode !== 403;
}

function toDnsRecords(records: readonly unknown[]): EmailDnsRecord[] {
  const dnsRecords: EmailDnsRecord[] = [];

  for (const record of records) {
    if (typeof record !== "object" || record === null) {
      continue;
    }

    const {
      name,
      priority,
      record: purpose,
      status,
      type,
      value,
    } = record as {
      name?: unknown;
      priority?: unknown;
      record?: unknown;
      status?: unknown;
      type?: unknown;
      value?: unknown;
    };

    // Records for features this app does not use (receiving, tracking)
    // arrive without a name and value, and are left out.
    if (
      typeof name !== "string" ||
      typeof type !== "string" ||
      typeof value !== "string"
    ) {
      continue;
    }

    dnsRecords.push({
      name,
      priority: typeof priority === "number" ? priority : null,
      purpose: typeof purpose === "string" ? purpose : "",
      status: typeof status === "string" ? status : "pending",
      type,
      value,
    });
  }

  return dnsRecords;
}

function createDomainsClient(env: EnvSource): ResendDomainsClient | null {
  const apiKey = getEnv(env).email.apiKey;

  return apiKey ? new Resend(apiKey).domains : null;
}

async function defaultRecordReady(
  ready: boolean,
  settings: ResolvedSettings,
): Promise<void> {
  if (ready === (settings.emailReadyAt !== null)) {
    return;
  }

  await markEmailReady(ready, settings);
}

const RATE_LIMIT_RETRY_DELAY_MS = 1_100;

type ResendResult = { error: { name?: string } | null };

// Resend allows only a couple of requests a second, and checking a domain
// takes two or three in a row. One that is turned away for that reason is
// tried once more after a pause.
async function callResend<T extends ResendResult>(
  call: () => Promise<T>,
): Promise<T> {
  const result = await call();

  if (result.error?.name !== "rate_limit_exceeded") {
    return result;
  }

  await new Promise((resolve) =>
    setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS),
  );

  return call();
}

type Inspection = {
  client: ResendDomainsClient | null;
  /** The domain's id in Resend, when the domain is there. */
  domainId: string | null;
  markReady: (ready: boolean) => Promise<void>;
  status: EmailStatus;
};

function toErrorStatus(
  error: { message: string; name?: string; statusCode?: number | null },
  domain: string,
  senderAddress: string,
): EmailStatus {
  return isRestrictedKeyError(error)
    ? { domain, senderAddress, state: "restricted_key" }
    : { message: error.message, senderAddress, state: "error" };
}

type SendingVerdict = "ready" | "not_ready" | "unknown";

function isVerifiedSendingRecord(record: unknown): boolean | null {
  if (typeof record !== "object" || record === null) {
    return null;
  }

  const { record: purpose, status } = record as {
    record?: unknown;
    status?: unknown;
  };

  // SPF and DKIM are the records sending depends on. The rest are for
  // receiving and for tracking, which this app does not use.
  return purpose === "SPF" || purpose === "DKIM" ? status === "verified" : null;
}

// Resend gives one status for the whole domain. A domain that is also set
// up to receive mail, or that is waiting on a spare sending record, counts
// as only partly verified while it sends perfectly well. So for a partly
// verified domain the sending records decide, and when they do not settle
// it either the answer is "cannot tell", which is not the same as "no".
// https://resend.com/docs/dashboard/domains/manage-domains
function judgeSending(
  status: string,
  records: readonly unknown[],
): SendingVerdict {
  if (status === "verified") {
    return "ready";
  }

  if (status !== "partially_verified" && status !== "partially_failed") {
    return "not_ready";
  }

  const sendingRecords = records
    .map(isVerifiedSendingRecord)
    .filter((verified) => verified !== null);

  return sendingRecords.length > 0 && sendingRecords.every(Boolean)
    ? "ready"
    : "unknown";
}

async function describeDomain(
  client: ResendDomainsClient,
  domainId: string,
  domain: string,
  senderAddress: string,
  markReady: (ready: boolean) => Promise<void>,
): Promise<EmailStatus> {
  const details = await callResend(() => client.get(domainId));

  if (details.error) {
    return toErrorStatus(details.error, domain, senderAddress);
  }

  const sending = judgeSending(details.data.status, details.data.records);

  if (sending === "ready") {
    await markReady(true);

    return { domain, senderAddress, state: "ready" };
  }

  // When it cannot be told, the mark is left as it is. A test email that
  // gets through is what sets it then, and the status says so.
  if (sending === "not_ready") {
    await markReady(false);
  }

  return {
    domain,
    ...(sending === "unknown" ? { mayAlreadySend: true as const } : {}),
    records: toDnsRecords(details.data.records),
    senderAddress,
    state: "domain_pending",
  };
}

const DOMAIN_PAGE_SIZE = 100;
// Enough for two thousand domains. Past that the answer is "could not
// tell", not "the domain is missing".
const MAX_DOMAIN_PAGES = 20;

type ListedDomain = { id: string; name: string; status: string };

type DomainSearch =
  | { error: null; match: ListedDomain | null }
  | {
      error: { message: string; name?: string; statusCode?: number | null };
      match: null;
    };

// Resend hands the account's domains over a page at a time, so the search
// follows the pages until the domain turns up or there are no more.
async function findDomain(
  client: ResendDomainsClient,
  domain: string,
): Promise<DomainSearch> {
  let after: string | undefined;

  for (let page = 0; page < MAX_DOMAIN_PAGES; page += 1) {
    const cursor = after;
    const listed = await callResend(() =>
      client.list(
        cursor
          ? { after: cursor, limit: DOMAIN_PAGE_SIZE }
          : { limit: DOMAIN_PAGE_SIZE },
      ),
    );

    if (listed.error) {
      return { error: listed.error, match: null };
    }

    const domains = listed.data.data;
    const match = domains.find(
      (candidate) => candidate.name.toLowerCase() === domain,
    );

    if (match) {
      return { error: null, match };
    }

    const last = domains[domains.length - 1];

    if (!listed.data.has_more || !last) {
      return { error: null, match: null };
    }

    after = last.id;
  }

  return {
    error: {
      message:
        "This Resend account has too many domains to search. Send a test email to check instead.",
    },
    match: null,
  };
}

// Finds out everything short of the domain's DNS records, which cost one
// more request and are fetched by whoever needs them.
async function inspectEmail({
  domainsClient,
  env = process.env,
  recordReady,
  settings,
}: EmailStatusOptions): Promise<Inspection> {
  const noop = async () => undefined;

  if (!domainsClient && resolveEmailDriver(env) === "capture") {
    return {
      client: null,
      domainId: null,
      markReady: noop,
      status: { state: "capture" },
    };
  }

  const client = domainsClient ?? createDomainsClient(env);

  if (!client) {
    return {
      client: null,
      domainId: null,
      markReady: noop,
      status: { state: "missing_key" },
    };
  }

  const resolvedSettings = settings ?? (await getSettings(env));
  const markReady =
    recordReady ??
    ((ready: boolean) => defaultRecordReady(ready, resolvedSettings));
  const senderAddress = extractEmailAddress(
    buildEmailAddresses(resolvedSettings).senderAddress,
  );
  const domain = getAddressDomain(senderAddress);
  const base = { client, domainId: null, markReady };

  if (!domain || isResendTestSender(senderAddress)) {
    await markReady(false);

    return { ...base, status: { senderAddress, state: "test_sender" } };
  }

  const found = await findDomain(client, domain);

  if (found.error) {
    // Nothing is known either way, so the mark is left as it is. A test
    // email that gets through is what sets it in this case.
    return {
      ...base,
      status: toErrorStatus(found.error, domain, senderAddress),
    };
  }

  const { match } = found;

  if (!match) {
    await markReady(false);

    return {
      ...base,
      status: { domain, senderAddress, state: "domain_missing" },
    };
  }

  if (match.status === "verified") {
    await markReady(true);

    return {
      ...base,
      domainId: match.id,
      status: { domain, senderAddress, state: "ready" },
    };
  }

  return {
    ...base,
    domainId: match.id,
    // The records are filled in by the caller.
    status: { domain, records: [], senderAddress, state: "domain_pending" },
  };
}

/**
 * Works out whether email can be sent, asking Resend about the sender's
 * domain when there is one to ask about. Also keeps the "email works" mark
 * in settings in step with what it finds.
 */
export async function getEmailStatus(
  options: EmailStatusOptions = {},
): Promise<EmailStatus> {
  const { client, domainId, markReady, status } = await inspectEmail(options);

  if (status.state !== "domain_pending" || !client || !domainId) {
    return status;
  }

  return describeDomain(
    client,
    domainId,
    status.domain,
    status.senderAddress,
    markReady,
  );
}

/** Adds the sender's domain to the Resend account, then reports the new status. */
export async function addEmailDomain(
  options: EmailStatusOptions = {},
): Promise<EmailStatus> {
  const { client, domainId, markReady, status } = await inspectEmail(options);

  if (status.state === "domain_pending" && client && domainId) {
    return describeDomain(
      client,
      domainId,
      status.domain,
      status.senderAddress,
      markReady,
    );
  }

  if (status.state !== "domain_missing" || !client) {
    return status;
  }

  const created = await callResend(() =>
    client.create({ name: status.domain }),
  );

  if (created.error) {
    return toErrorStatus(created.error, status.domain, status.senderAddress);
  }

  return {
    domain: status.domain,
    records: toDnsRecords(created.data.records),
    senderAddress: status.senderAddress,
    state: "domain_pending",
  };
}

/** Asks Resend to look at the domain's DNS records again, then reports the status. */
export async function recheckEmailDomain(
  options: EmailStatusOptions = {},
): Promise<EmailStatus> {
  const { client, domainId, markReady, status } = await inspectEmail(options);

  if (status.state !== "domain_pending" || !client || !domainId) {
    return status;
  }

  // Starts a check on Resend's side. Its result can take a moment to show,
  // so the status returned here may still say the records are pending.
  const started = await callResend(() => client.verify(domainId));

  if (started.error) {
    // The check never started, which is not the same as "still waiting".
    return toErrorStatus(started.error, status.domain, status.senderAddress);
  }

  return describeDomain(
    client,
    domainId,
    status.domain,
    status.senderAddress,
    markReady,
  );
}

/** True when an administrator should be told that email still needs work. */
export function emailNeedsAttention(
  settings: ResolvedSettings,
  env: EnvSource = process.env,
): boolean {
  try {
    if (resolveEmailDriver(env) === "capture") {
      return false;
    }
  } catch {
    return true;
  }

  return settings.emailReadyAt === null;
}
