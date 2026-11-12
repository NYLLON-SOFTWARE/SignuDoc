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

function isRestrictedKeyError(error: {
  name?: string;
  statusCode?: number | null;
}): boolean {
  return (
    error.name === "restricted_api_key" ||
    error.name === "invalid_access" ||
    error.statusCode === 401 ||
    error.statusCode === 403
  );
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

  await markEmailReady(ready);
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

  if (details.data.status === "verified") {
    await markReady(true);

    return { domain, senderAddress, state: "ready" };
  }

  await markReady(false);

  return {
    domain,
    records: toDnsRecords(details.data.records),
    senderAddress,
    state: "domain_pending",
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

  const listed = await callResend(() => client.list({ limit: 100 }));

  if (listed.error) {
    // Nothing is known either way, so the mark is left as it is. A test
    // email that gets through is what sets it in this case.
    return {
      ...base,
      status: toErrorStatus(listed.error, domain, senderAddress),
    };
  }

  const match = listed.data.data.find(
    (candidate) => candidate.name.toLowerCase() === domain,
  );

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
  await callResend(() => client.verify(domainId));

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
