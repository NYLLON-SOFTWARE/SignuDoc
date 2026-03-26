import { Resend } from "resend";

import { type EmailTemplateKind } from "../types/domain.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";
import { assertServiceConfig } from "./service-config.ts";

const EMAIL_ENV_KEYS = [
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "SUPPORT_EMAIL",
] as const;

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

export function createEmailService({
  env = process.env,
  resendClient,
}: CreateEmailServiceOptions = {}): EmailService {
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
