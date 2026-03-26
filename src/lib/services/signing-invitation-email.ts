import { escapeHtml } from "../utils/html.ts";
import { withUserEmailLegalFooter } from "./email-legal-footer.ts";
import { type TransactionalEmailMessage } from "./email.ts";

type SigningInvitationEmailInput = {
  envelopeTitle: string;
  senderName: string;
  signerEmail: string;
  signerName: string;
  signingUrl: string;
};

export function buildSigningInvitationEmail(
  input: SigningInvitationEmailInput,
): TransactionalEmailMessage {
  const subject = `${input.senderName} requested your signature on "${input.envelopeTitle}"`;
  const textBody = [
    `Hi ${input.signerName},`,
    "",
    `${input.senderName} sent you "${input.envelopeTitle}" through SignuDoc.`,
    "",
    "Review and sign the document here:",
    input.signingUrl,
    "",
    "You do not need a SignuDoc account to sign.",
    "If you receive a newer invitation or reminder link, use the newest one.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.signerName)},</p>`,
    `<p>${escapeHtml(input.senderName)} sent you &ldquo;${escapeHtml(input.envelopeTitle)}&rdquo; through SignuDoc.</p>`,
    `<p><a href="${escapeHtml(input.signingUrl)}">Review and sign the document</a></p>`,
    "<p>You do not need a SignuDoc account to sign.</p>",
    "<p>If you receive a newer invitation or reminder link, use the newest one.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter({
    htmlBody,
    textBody,
  });

  return {
    htmlBody: legalFooter.htmlBody,
    subject,
    template: "signing_invitation",
    textBody: legalFooter.textBody,
    to: input.signerEmail,
  };
}
