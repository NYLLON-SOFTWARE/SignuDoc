import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { Resend } from "resend";

import { type EmailTemplateKind } from "../types/domain.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";
import { assertServiceConfig } from "./service-config.ts";

const EMAIL_ENV_KEYS = [
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "SUPPORT_EMAIL",
] as const;

const DEFAULT_CAPTURE_DIR = ".data/outbox";
const DEFAULT_CAPTURE_SENDER_ADDRESS = "SignuDoc <dev@signudoc.localhost>";
const DEFAULT_CAPTURE_SUPPORT_ADDRESS = "support@signudoc.localhost";

export type EmailDriver = "capture" | "resend";

export type TransactionalEmailMessage = {
  htmlBody?: string;
  replyTo?: string;
  subject: string;
  template: EmailTemplateKind;
  textBody: string;
  to: string;
};

export type EmailDeliveryResult = {
  accepted: string[];
  messageId?: string;
  rejected: string[];
};

export type EmailSendOptions = {
  idempotencyKey?: string;
};

type CreateEmailServiceOptions = {
  env?: EnvSource;
  resendClient?: Resend;
};

function getResendErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return "Email delivery failed.";
}

function buildResendOptions(options?: EmailSendOptions) {
  return options?.idempotencyKey
    ? {
        idempotencyKey: options.idempotencyKey,
      }
    : undefined;
}

function buildResendPayload(
  message: TransactionalEmailMessage,
  config: {
    senderAddress: string;
    supportAddress: string;
  },
) {
  return {
    from: config.senderAddress,
    html: message.htmlBody,
    replyTo: message.replyTo ?? config.supportAddress,
    subject: message.subject,
    tags: [
      {
        name: "category",
        value: message.template,
      },
    ],
    text: message.textBody,
    to: [message.to],
  };
}

export interface EmailService {
  send(
    message: TransactionalEmailMessage,
    options?: EmailSendOptions,
  ): Promise<EmailDeliveryResult>;
  sendBatch(
    messages: readonly TransactionalEmailMessage[],
    options?: EmailSendOptions,
  ): Promise<EmailDeliveryResult[]>;
}

export function resolveEmailDriver(env: EnvSource = process.env): EmailDriver {
  const configuredDriver = env.EMAIL_DRIVER?.trim().toLowerCase();

  if (!configuredDriver) {
    return "resend";
  }

  if (configuredDriver === "capture" || configuredDriver === "resend") {
    return configuredDriver;
  }

  throw new Error(
    `Unknown EMAIL_DRIVER "${configuredDriver}". Use "resend" or "capture".`,
  );
}

/**
 * Development and test driver: nothing is sent. Each message is written as a
 * JSON file so a person (or the end-to-end test) can read the links in it.
 */
function createCaptureEmailService(env: EnvSource): EmailService {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "EMAIL_DRIVER=capture drops every email and cannot be used in production.",
    );
  }

  const emailEnv = getEnv(env).email;
  // The comment stops Turbopack from tracing the whole project into the
  // server bundle because of a path it cannot analyse.
  const captureDir = path.resolve(
    /*turbopackIgnore: true*/ env.EMAIL_CAPTURE_DIR?.trim() ||
      DEFAULT_CAPTURE_DIR,
  );
  const config = {
    senderAddress: emailEnv.senderAddress ?? DEFAULT_CAPTURE_SENDER_ADDRESS,
    supportAddress: emailEnv.supportAddress ?? DEFAULT_CAPTURE_SUPPORT_ADDRESS,
  };

  async function capture(
    message: TransactionalEmailMessage,
  ): Promise<EmailDeliveryResult> {
    const messageId = `capture-${randomUUID()}`;
    const filePath = path.join(
      /*turbopackIgnore: true*/ captureDir,
      `${String(Date.now())}-${messageId}.json`,
    );

    const temporaryPath = `${filePath}.tmp`;

    // Written under a temporary name and renamed, so anything watching the
    // outbox never reads a half-written file.
    await mkdir(captureDir, { recursive: true });
    await writeFile(
      temporaryPath,
      JSON.stringify(
        {
          ...buildResendPayload(message, config),
          capturedAt: new Date().toISOString(),
          messageId,
          template: message.template,
        },
        null,
        2,
      ),
    );
    await rename(temporaryPath, filePath);
    console.info(
      `[email:capture] ${message.template} to ${message.to} -> ${filePath}`,
    );

    return {
      accepted: [message.to],
      messageId,
      rejected: [],
    };
  }

  return {
    send: (message) => capture(message),
    async sendBatch(messages) {
      const results: EmailDeliveryResult[] = [];

      for (const message of messages) {
        results.push(await capture(message));
      }

      return results;
    },
  };
}

export function createEmailService({
  env = process.env,
  resendClient,
}: CreateEmailServiceOptions = {}): EmailService {
  if (!resendClient && resolveEmailDriver(env) === "capture") {
    return createCaptureEmailService(env);
  }

  assertServiceConfig("email", EMAIL_ENV_KEYS, env);

  const emailEnv = getEnv(env).email;
  const client = resendClient ?? new Resend(emailEnv.apiKey!);
  const config = {
    senderAddress: emailEnv.senderAddress!,
    supportAddress: emailEnv.supportAddress!,
  };

  return {
    async send(message, options) {
      const { data, error } = await client.emails.send(
        buildResendPayload(message, config),
        buildResendOptions(options),
      );

      if (error) {
        throw new Error(getResendErrorMessage(error));
      }

      return {
        accepted: [message.to],
        messageId: data?.id,
        rejected: [],
      };
    },

    async sendBatch(messages, options) {
      if (messages.length === 0) {
        return [];
      }

      const { data, error } = await client.batch.send(
        messages.map((message) => buildResendPayload(message, config)),
        buildResendOptions(options),
      );

      if (error) {
        throw new Error(getResendErrorMessage(error));
      }

      return messages.map((message, index) => ({
        accepted: [message.to],
        messageId: data?.data[index]?.id,
        rejected: [],
      }));
    },
  };
}
