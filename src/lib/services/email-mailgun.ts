import { type ResolvedSettings } from "../settings.ts";
import { type EnvSource } from "../utils/env.ts";
import {
  buildEmailAddresses,
  type EmailAddresses,
  extractEmailAddress,
  getAddressDomain,
  isResendTestSender,
} from "./email-addresses.ts";
import type {
  EmailDeliveryResult,
  EmailService,
  TransactionalEmailMessage,
} from "./email.ts";
import { ServiceConfigurationError } from "./service-config.ts";

// Mailgun has no idempotency key or per-message batch: retries after a lost answer can duplicate a send.

const REQUIRED_VARIABLES = ["MAILGUN_API_KEY", "MAILGUN_DOMAIN"] as const;
const API_BASE_URLS = {
  eu: "https://api.eu.mailgun.net",
  us: "https://api.mailgun.net",
} as const;

const RETRIES = 3;
const DEFAULT_RETRY_WAIT_MS = 1_000;
// Longer waits are not retried in-request: a signing request is waiting on the send.
const MAX_RETRY_WAIT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

type MailgunConfig = {
  apiKey: string;
  baseUrl: string;
  domain: string;
};

function readConfig(env: EnvSource): MailgunConfig {
  const missing = REQUIRED_VARIABLES.filter((name) => !env[name]?.trim());

  if (missing.length > 0) {
    throw new ServiceConfigurationError("email", missing);
  }

  const region = env.MAILGUN_REGION?.trim().toLowerCase() || "us";

  if (region !== "us" && region !== "eu") {
    throw new Error(`Unknown MAILGUN_REGION "${region}". Use "us" or "eu".`);
  }

  return {
    apiKey: env.MAILGUN_API_KEY!.trim(),
    baseUrl: API_BASE_URLS[region],
    domain: env.MAILGUN_DOMAIN!.trim().toLowerCase(),
  };
}

function authorization(apiKey: string): string {
  return `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`;
}

function buildForm(
  message: TransactionalEmailMessage,
  config: EmailAddresses,
): FormData {
  const form = new FormData();
  const replyTo = message.replyTo ?? config.supportAddress ?? undefined;

  form.append("from", config.senderAddress);
  form.append("to", message.to);
  form.append("subject", message.subject);
  form.append("text", message.textBody);
  form.append("o:tag", message.template);

  if (message.htmlBody) {
    form.append("html", message.htmlBody);
  }

  if (replyTo) {
    form.append("h:Reply-To", replyTo);
  }

  for (const attachment of message.attachments ?? []) {
    form.append(
      "attachment",
      new Blob([Buffer.from(attachment.content)], {
        type: attachment.contentType,
      }),
      attachment.filename,
    );
  }

  return form;
}

export function retryWaitMs(response: Response, now = Date.now()): number {
  const value = response.headers.get("retry-after")?.trim();

  if (!value) {
    return DEFAULT_RETRY_WAIT_MS;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(seconds * 1000, 0);
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? DEFAULT_RETRY_WAIT_MS : Math.max(date - now, 0);
}

type CreateMailgunEmailServiceOptions = {
  env?: EnvSource;
  fetch?: typeof fetch;
  resolveAddresses: () => Promise<EmailAddresses>;
  wait: (milliseconds: number) => Promise<void>;
};

export function createMailgunEmailService({
  env = process.env,
  fetch: send = fetch,
  resolveAddresses,
  wait,
}: CreateMailgunEmailServiceOptions): EmailService {
  const { apiKey, baseUrl, domain } = readConfig(env);
  const url = `${baseUrl}/v3/${encodeURIComponent(domain)}/messages`;

  async function sendOne(
    message: TransactionalEmailMessage,
  ): Promise<EmailDeliveryResult> {
    const addresses = await resolveAddresses();

    for (let attempt = 0; ; attempt += 1) {
      // A FormData body is read once, so each attempt builds its own.
      // The signal also bounds reading the answer; a timed-out send is not retried, as it may have gone out.
      const response = await send(url, {
        body: buildForm(message, addresses),
        headers: { authorization: authorization(apiKey) },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const waitMs = retryWaitMs(response);

      // Mailgun drops (does not queue) a 429/5xx send.
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < RETRIES &&
        waitMs <= MAX_RETRY_WAIT_MS
      ) {
        await response.body?.cancel();
        await wait(waitMs);
        continue;
      }

      const answer = (await response.json().catch(() => null)) as {
        id?: string;
        message?: string;
      } | null;

      if (!response.ok) {
        throw new Error(
          answer?.message || `Email delivery failed (${response.status}).`,
        );
      }

      return { accepted: [message.to], messageId: answer?.id, rejected: [] };
    }
  }

  return {
    send: (message) => sendOne(message),
    async sendBatch(messages) {
      const results: EmailDeliveryResult[] = [];

      for (const message of messages) {
        results.push(await sendOne(message));
      }

      return results;
    },
  };
}

export type MailgunEmailStatus =
  | { state: "ready"; domain: string; senderAddress: string }
  | {
      state: "mailgun";
      domain: string;
      problem: "config" | "no_sender" | "wrong_domain" | "unverified" | "error";
      message?: string;
      senderAddress: string | null;
    };

type DescribeMailgunEmailOptions = {
  env?: EnvSource;
  fetch?: typeof fetch;
  markReady: (ready: boolean) => Promise<void>;
  settings: ResolvedSettings;
};

export async function describeMailgunEmail({
  env = process.env,
  fetch: send = fetch,
  markReady,
  settings,
}: DescribeMailgunEmailOptions): Promise<MailgunEmailStatus> {
  let config: MailgunConfig;

  try {
    config = readConfig(env);
  } catch (error) {
    await markReady(false);
    return {
      domain: env.MAILGUN_DOMAIN?.trim().toLowerCase() ?? "",
      message: error instanceof Error ? error.message : String(error),
      problem: "config",
      senderAddress: null,
      state: "mailgun",
    };
  }

  const { apiKey, baseUrl, domain } = config;
  const senderAddress = extractEmailAddress(
    buildEmailAddresses(settings).senderAddress,
  );
  const senderDomain = getAddressDomain(senderAddress);

  // Unset sender falls back to Resend's test address, which Mailgun cannot send from.
  if (!senderDomain || isResendTestSender(senderAddress)) {
    await markReady(false);
    return {
      domain,
      problem: "no_sender",
      senderAddress: null,
      state: "mailgun",
    };
  }

  if (senderDomain.toLowerCase() !== domain) {
    await markReady(false);
    return { domain, problem: "wrong_domain", senderAddress, state: "mailgun" };
  }

  let state: string | undefined;

  try {
    const response = await send(
      `${baseUrl}/v4/domains/${encodeURIComponent(domain)}`,
      {
        headers: { authorization: authorization(apiKey) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const answer = (await response.json().catch(() => null)) as {
      domain?: { state?: string };
      message?: string;
    } | null;

    if (!response.ok) {
      // Unknown state: leave the ready mark untouched.
      return {
        domain,
        message: answer?.message || `Mailgun answered ${response.status}.`,
        problem: "error",
        senderAddress,
        state: "mailgun",
      };
    }

    state = answer?.domain?.state;
  } catch (error) {
    return {
      domain,
      message: error instanceof Error ? error.message : String(error),
      problem: "error",
      senderAddress,
      state: "mailgun",
    };
  }

  if (state !== "active") {
    await markReady(false);
    return { domain, problem: "unverified", senderAddress, state: "mailgun" };
  }

  await markReady(true);
  return { domain, senderAddress, state: "ready" };
}
