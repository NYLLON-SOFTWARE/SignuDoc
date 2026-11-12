import { type DbExecutor, getDb } from "./db/connection.ts";
import {
  renewRecipientDownloadLinks,
  type RenewedDownloadLinks,
} from "./downloads.ts";
import { getBranding } from "./settings.ts";
import { recordEmailSent } from "./services/audit.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import { RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS } from "./types/domain.ts";
import { escapeHtml } from "./utils/html.ts";

const TTL_DAYS = RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS / (24 * 60 * 60);

/** Sends fresh download links to the signer an expired link belonged to. */
export async function sendFreshDownloadLinks(
  token: string,
  {
    database = getDb(),
    emailService = createEmailService(),
  }: { database?: DbExecutor; emailService?: EmailService } = {},
): Promise<RenewedDownloadLinks> {
  const branding = await getBranding();

  return renewRecipientDownloadLinks(token, {
    database,
    async sendLinks({ envelope, evidenceUrl, signedUrl, signer }) {
      const subject = `New download links for "${envelope.title}"`;
      const textBody = [
        `Hi ${signer.name},`,
        "",
        `Here are new download links for "${envelope.title}" in ${branding.productName}. They work for ${String(TTL_DAYS)} days.`,
        "",
        ...(signedUrl ? [`Signed PDF: ${signedUrl}`] : []),
        `Certificate: ${evidenceUrl}`,
        "",
        "Download and keep the files: they are your copy of the record.",
      ].join("\n");
      const htmlBody = [
        `<p>Hi ${escapeHtml(signer.name)},</p>`,
        `<p>Here are new download links for &ldquo;${escapeHtml(envelope.title)}&rdquo; in ${escapeHtml(branding.productName)}. They work for ${String(TTL_DAYS)} days.</p>`,
        "<p>",
        signedUrl
          ? `<a href="${escapeHtml(signedUrl)}">Download signed PDF</a><br />`
          : "",
        `<a href="${escapeHtml(evidenceUrl)}">Download certificate</a></p>`,
        "<p>Download and keep the files: they are your copy of the record.</p>",
      ].join("");
      const body = withUserEmailLegalFooter({ htmlBody, textBody }, branding);
      const delivery = await emailService.send({
        htmlBody: body.htmlBody,
        subject,
        template: "download_links",
        textBody: body.textBody,
        to: signer.email,
      });

      await recordEmailSent(
        {
          envelopeId: envelope.id,
          messageId: delivery.messageId,
          recipient: signer.email,
          signerId: signer.id,
          template: "download_links",
        },
        database,
      );
    },
  });
}
