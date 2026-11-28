import { type Branding } from "../branding.ts";
import { formatDeadline } from "../envelope-deadline.ts";
import { escapeHtml } from "../utils/html.ts";
import { withUserEmailLegalFooter } from "./email-legal-footer.ts";
import { type TransactionalEmailMessage } from "./email.ts";

type SigningInvitationEmailInput = {
  branding: Branding;
  envelopeTitle: string;
  invitation?: { message: string | null; subject: string | null };
  /** The envelope's deadline, when it has one. */
  expiresAt?: number | null;
  /** An approver is asked to approve, not to sign. A signer by default. */
  role?: "approver" | "signer";
  senderName: string;
  signerEmail: string;
  signerName: string;
  signingUrl: string;
};

/** "This request expires on …", or nothing for an envelope with no deadline. */
export function buildDeadlineLine(
  expiresAt: number | null | undefined,
): string | null {
  return typeof expiresAt === "number"
    ? `This request expires on ${formatDeadline(expiresAt)}.`
    : null;
}

/** What the person is asked to do, in the invitation and the reminders. */
export function describeRequestedAction(
  role: "approver" | "signer" = "signer",
) {
  return role === "approver"
    ? {
        accountLine: "approve",
        linkText: "Review and approve or reject the document",
        noun: "approval",
        verb: "approve",
      }
    : {
        accountLine: "sign",
        linkText: "Review and sign the document",
        noun: "signature",
        verb: "sign",
      };
}

export function buildSigningInvitationEmail(
  input: SigningInvitationEmailInput,
): TransactionalEmailMessage {
  const { productName } = input.branding;
  const action = describeRequestedAction(input.role);
  const subject =
    input.invitation?.subject ??
    `${input.senderName} requested your ${action.noun} on "${input.envelopeTitle}"`;
  const message = input.invitation?.message;
  const deadlineLine = buildDeadlineLine(input.expiresAt);
  const textBody = [
    `Hi ${input.signerName},`,
    "",
    `${input.senderName} sent you "${input.envelopeTitle}" through ${productName}.`,
    ...(message ? ["", message] : []),
    "",
    `${action.linkText} here:`,
    input.signingUrl,
    ...(deadlineLine ? ["", deadlineLine] : []),
    "",
    `You do not need a ${productName} account to ${action.accountLine}.`,
    "If you receive a newer invitation or reminder link, use the newest one.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.signerName)},</p>`,
    `<p>${escapeHtml(input.senderName)} sent you &ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; through ${escapeHtml(productName)}.</p>`,
    message ? `<p>${escapeHtml(message).replace(/\r?\n/g, "<br>")}</p>` : "",
    `<p><a href="${escapeHtml(input.signingUrl)}">${escapeHtml(action.linkText)}</a></p>`,
    deadlineLine ? `<p>${escapeHtml(deadlineLine)}</p>` : "",
    `<p>You do not need a ${escapeHtml(productName)} account to ${action.accountLine}.</p>`,
    "<p>If you receive a newer invitation or reminder link, use the newest one.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter(
    {
      htmlBody,
      textBody,
    },
    input.branding,
  );

  return {
    htmlBody: legalFooter.htmlBody,
    subject,
    template: "signing_invitation",
    textBody: legalFooter.textBody,
    to: input.signerEmail,
  };
}
