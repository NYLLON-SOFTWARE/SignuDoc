import { isResendTestSender } from "./services/email-addresses.ts";
import {
  createEmailService,
  resolveEmailAddresses,
  type EmailService,
} from "./services/email.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import { getBranding, getSettings, markEmailReady } from "./settings.ts";
import { type EnvSource } from "./utils/env.ts";
import { escapeHtml } from "./utils/html.ts";

export type TestEmailResult =
  { sent: true; to: string } | { sent: false; message: string };

type SendTestEmailInput = {
  emailService?: EmailService;
  env?: EnvSource;
  name: string;
  to: string;
};

/**
 * Sends the administrator a message through the real email setup, so they
 * can see it arrive. A failure comes back with the mail provider's own
 * words, which usually say exactly what is wrong.
 */
export async function sendTestEmail({
  emailService,
  env = process.env,
  name,
  to,
}: SendTestEmailInput): Promise<TestEmailResult> {
  try {
    const branding = await getBranding(env);
    const { productName } = branding;
    const textBody = [
      `Hi ${name},`,
      "",
      `This is a test message from ${productName}. If you are reading it, email is working.`,
    ].join("\n");
    const htmlBody = [
      `<p>Hi ${escapeHtml(name)},</p>`,
      `<p>This is a test message from ${escapeHtml(productName)}. If you are reading it, email is working.</p>`,
    ].join("");
    const content = withUserEmailLegalFooter(
      { htmlBody, textBody },
      branding,
      env,
    );

    // Which sender this test is about to prove, noted before it is sent:
    // an administrator may save a different one while it is on its way.
    const testedSettings = await getSettings(env);
    const { senderAddress: testedSender } = await resolveEmailAddresses(env);

    await (emailService ?? createEmailService({ env })).send({
      htmlBody: content.htmlBody,
      subject: `Test email from ${productName}`,
      template: "test_email",
      textBody: content.textBody,
      to,
    });

    // A message accepted from the organization's own address means that
    // address's domain is verified, even when the API key is not allowed to
    // say so. The shared test address proves nothing: it only ever reaches
    // the owner of the Resend account.
    if (!isResendTestSender(testedSender)) {
      await markEmailReady(true, testedSettings);
    }

    return { sent: true, to };
  } catch (error) {
    return {
      message:
        error instanceof Error && error.message
          ? error.message
          : "The test email could not be sent.",
      sent: false,
    };
  }
}
