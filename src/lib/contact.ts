import { contactFormSchema, type ContactFormInput } from "./schemas/contact.ts";
import { resolvePublicSupportAddress } from "./public-contact.ts";
import { createEmailService } from "./services/email.ts";
import { ServiceConfigurationError } from "./services/service-config.ts";
import { type EnvSource } from "./utils/env.ts";
import { escapeHtml } from "./utils/html.ts";

type ContactFieldName = "email" | "message" | "name";

type SubmitPublicContactMessageOptions = {
  env?: EnvSource;
};

type SubmitPublicContactMessageResult = {
  ignored: boolean;
  messageId?: string;
};

export class ContactSubmissionError extends Error {
  readonly fieldErrors: Partial<Record<ContactFieldName, string>>;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode: number,
    fieldErrors: Partial<Record<ContactFieldName, string>> = {},
  ) {
    super(message);
    this.name = "ContactSubmissionError";
    this.fieldErrors = fieldErrors;
    this.statusCode = statusCode;
  }
}

function formatSubmittedAt(date = new Date()): string {
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function isEmailServiceConfigurationError(error: unknown): boolean {
  if (error instanceof ServiceConfigurationError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.trim().toLowerCase();

  return (
    normalizedMessage.includes("api key is invalid") ||
    normalizedMessage.includes("invalid api key") ||
    normalizedMessage.includes("missing api key") ||
    normalizedMessage.includes("restricted api key") ||
    normalizedMessage.includes("invalid from address")
  );
}

function buildContactValidationError(input: unknown): ContactFormInput {
  const parsedInput = contactFormSchema.safeParse(input);

  if (parsedInput.success) {
    return parsedInput.data;
  }

  const fieldErrors: Partial<Record<ContactFieldName, string>> = {};

  for (const issue of parsedInput.error.issues) {
    const field = issue.path[0];

    if (field === "name") {
      fieldErrors.name = "Enter your name";
    }

    if (field === "email") {
      fieldErrors.email = "Enter a valid email address";
    }

    if (field === "message") {
      fieldErrors.message =
        issue.code === "too_big"
          ? "Message must be 5000 characters or fewer"
          : "Enter a message";
    }
  }

  throw new ContactSubmissionError(
    "Please review the highlighted fields.",
    400,
    fieldErrors,
  );
}

export async function submitPublicContactMessage(
  input: unknown,
  { env = process.env }: SubmitPublicContactMessageOptions = {},
): Promise<SubmitPublicContactMessageResult> {
  const parsedInput = buildContactValidationError(input);

  if (parsedInput.company) {
    return {
      ignored: true,
    };
  }

  const supportAddress = await resolvePublicSupportAddress(env);
  const submittedAt = formatSubmittedAt();
  const escapedMessageHtml = escapeHtml(parsedInput.message).replaceAll(
    "\n",
    "<br />",
  );

  try {
    const emailService = createEmailService({ env });
    const deliveryResult = await emailService.send({
      htmlBody: [
        "<p>A new public contact request was submitted through SignuDoc.</p>",
        `<p><strong>Name:</strong> ${escapeHtml(parsedInput.name)}<br /><strong>Email:</strong> ${escapeHtml(parsedInput.email)}<br /><strong>Submitted at:</strong> ${escapeHtml(submittedAt)}</p>`,
        `<p><strong>Message:</strong><br />${escapedMessageHtml}</p>`,
      ].join(""),
      replyTo: parsedInput.email,
      subject: `[Contact] ${parsedInput.name}`,
      template: "contact_form",
      textBody: [
        "A new public contact request was submitted through SignuDoc.",
        "",
        `Name: ${parsedInput.name}`,
        `Email: ${parsedInput.email}`,
        `Submitted at: ${submittedAt}`,
        "",
        "Message:",
        parsedInput.message,
      ].join("\n"),
      to: supportAddress,
    });

    return {
      ignored: false,
      messageId: deliveryResult.messageId,
    };
  } catch (error) {
    if (isEmailServiceConfigurationError(error)) {
      throw new ContactSubmissionError(
        "Contact form is temporarily unavailable.",
        503,
      );
    }

    throw error;
  }
}
