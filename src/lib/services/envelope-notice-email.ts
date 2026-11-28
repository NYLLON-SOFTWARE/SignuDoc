import {
  type DbExecutor,
  type DbPool,
  queryOne,
  withTransaction,
} from "../db/connection.ts";
import { sanitizeFileNameSegment } from "../downloads.ts";
import { getBranding } from "../settings.ts";
import { escapeHtml } from "../utils/html.ts";
import { recordEmailSent } from "./audit.ts";
import {
  type EmailAttachment,
  type EmailDeliveryResult,
  type EmailService,
  type TransactionalEmailMessage,
  fitsAsAttachments,
} from "./email.ts";
import { withUserEmailLegalFooter } from "./email-legal-footer.ts";
import { createStorageService } from "./storage.ts";

type NoticeRecipient = { email: string; id?: string; name: string };
type NoticeEnvelope = { id: string; title: string };
type SourceEnvelope = {
  id: string;
  sourcePdfFilename: string;
  sourcePdfKey: string;
};

export async function readOriginalPdfAttachment(
  envelope: SourceEnvelope,
): Promise<EmailAttachment[] | undefined> {
  try {
    const { body } = await createStorageService().getObject(
      envelope.sourcePdfKey,
    );
    const name = sanitizeFileNameSegment(
      envelope.sourcePdfFilename.replace(/\.pdf$/i, ""),
    );
    const attachments = [
      {
        content: body,
        contentType: "application/pdf",
        filename: `${name || "document"}.pdf`,
      },
    ];
    return fitsAsAttachments(attachments) ? attachments : undefined;
  } catch (error) {
    console.error(
      `Could not attach the original PDF for envelope ${envelope.id}:`,
      error,
    );
    return undefined;
  }
}

export async function sendSigningInvitation(input: {
  database: DbPool;
  emailService: EmailService;
  envelopeId: string;
  message: TransactionalEmailMessage;
  signerId: string;
  tokenHash: string;
  transaction?: DbExecutor;
}) {
  const {
    database,
    emailService,
    envelopeId,
    message,
    signerId,
    tokenHash,
    transaction,
  } = input;
  if (process.env.SIGNUDOC_EMAIL_SIGNER_INVITATION_ATTACHMENT !== "1") {
    return emailService.send(message);
  }

  const send = async (tx: DbExecutor) => {
    // Hold the current recipient stable until the email provider accepts it.
    // A stale link, corrected address, or gated page must never release a PDF.
    const source = await queryOne<SourceEnvelope>(
      tx,
      `
      SELECT e.id, e.source_pdf_filename AS "sourcePdfFilename", e.source_pdf_key AS "sourcePdfKey"
      FROM envelopes e JOIN signers s ON s.envelope_id = e.id
      WHERE e.id = $1 AND s.id = $2 AND lower(s.email) = lower($3)
        AND s.signing_token_hash = $4 AND s.status = 'notified'
        AND e.status = 'sent' AND NOT e.part11 AND e.delivery = 'email'
        AND s.access_code_hash IS NULL AND NOT s.require_email_code
      FOR SHARE OF s
    `,
      [envelopeId, signerId, message.to, tokenHash],
    );
    const attachments = source
      ? await readOriginalPdfAttachment(source)
      : undefined;
    return emailService.send(
      attachments ? { ...message, attachments } : message,
    );
  };

  if (transaction) return send(transaction);

  let accepted: EmailDeliveryResult | undefined;
  try {
    return await withTransaction(async (tx) => {
      accepted = await send(tx);
      return accepted;
    }, database);
  } catch (error) {
    if (!accepted) throw error;
    // The transaction only read and locked rows, and the email already went out.
    console.error(
      `Could not close the invitation read transaction for ${envelopeId}:`,
      error,
    );
    return accepted;
  }
}

/** Courtesy emails deliberately carry no private signing link. */
export async function sendEnvelopeNotices(input: {
  attachments?: EmailAttachment[];
  database: DbExecutor;
  emailService: EmailService;
  envelope: NoticeEnvelope;
  eventKey: string;
  message: string;
  recipients: readonly NoticeRecipient[];
  template:
    | "copy_recipient_activity"
    | "copy_recipient_sent"
    | "ordered_signing_started"
    | "sender_sent_copy";
}): Promise<void> {
  const {
    attachments,
    database,
    emailService,
    envelope,
    eventKey,
    message,
    recipients,
    template,
  } = input;
  if (recipients.length === 0) return;
  try {
    const branding = await getBranding();
    const messages = recipients.map((recipient) => ({
      ...withUserEmailLegalFooter(
        {
          htmlBody: `<p>Hi ${escapeHtml(recipient.name)},</p><p>${escapeHtml(message)}</p>`,
          textBody: `Hi ${recipient.name},\n\n${message}`,
        },
        branding,
      ),
      ...(attachments ? { attachments } : {}),
      subject: message.replace(/\s+/g, " "),
      template,
      to: recipient.email,
    }));
    // Resend accepts at most 100 messages per batch.
    for (let offset = 0; offset < messages.length; offset += 100) {
      const batch = messages.slice(offset, offset + 100);
      const options = { idempotencyKey: `${template}/${eventKey}/${offset}` };
      const deliveries =
        batch.length === 1
          ? [await emailService.send(batch[0]!, options)]
          : await emailService.sendBatch(batch, options);
      for (const [index, delivery] of deliveries.entries()) {
        const recipient = recipients[offset + index]!;
        await recordEmailSent(
          {
            envelopeId: envelope.id,
            messageId: delivery.messageId,
            recipient: recipient.email,
            signerId: recipient.id,
            template,
          },
          database,
        );
      }
    }
  } catch (error) {
    console.error(
      `Failed to send ${template} email for envelope ${envelope.id}:`,
      error,
    );
  }
}
