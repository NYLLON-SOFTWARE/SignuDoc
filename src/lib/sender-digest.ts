import { buildBranding, type Branding } from "./branding.ts";
import { type DbPool, queryMany, withTransaction } from "./db/connection.ts";
import { consumeRateLimit } from "./security/rate-limit.ts";
import { withUserEmailLegalFooter } from "./services/email-legal-footer.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { requireConfigValue } from "./services/service-config.ts";
import { readStoredSettings, resolveSettings } from "./settings.ts";
import { type EnvSource, resolveAppUrl } from "./utils/env.ts";
import { escapeHtml } from "./utils/html.ts";

const DAY_SECONDS = 86_400;
const SENDERS_PER_BATCH = 200;
const ENVELOPES_PER_MESSAGE = 20;

// Current signers and approvers are notified. Copy recipients and later
// signers are pending, and expired envelopes have their own notice.
const outstanding = `
  e.status = 'sent'
  AND (e.sent_at IS NULL OR e.sent_at <= $1)
  AND (e.expires_at IS NULL OR e.expires_at > $1)
  AND EXISTS (
    SELECT 1 FROM signers s
    WHERE s.envelope_id = e.id
      AND s.status = 'notified'
      AND s.role IN ('signer', 'approver')
  )
`;
const eligibleSender = `
  u."emailVerified"
  AND NOT EXISTS (
    SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
  )
`;

type DigestEnvelope = {
  id: string;
  title: string;
  email: string;
  name: string;
};

function buildDigest(
  sender: DigestEnvelope,
  envelopes: DigestEnvelope[],
  branding: Branding,
  env: EnvSource,
): TransactionalEmailMessage {
  const appUrl = requireConfigValue("app", "APP_URL", resolveAppUrl(env));
  const dashboard = new URL("/dashboard", appUrl).toString();
  const name =
    sender.name.trim().split(/\s+/, 1)[0] || sender.email.split("@", 1)[0];
  const greeting = `Hi ${name},`;
  const intro = "These documents are waiting for signatures or approvals.";
  const documents = envelopes
    .slice(0, ENVELOPES_PER_MESSAGE)
    .map(({ id, title }) => ({
      title: title.replace(/\s+/g, " ").trim(),
      url: new URL(`/envelopes/${encodeURIComponent(id)}`, appUrl).toString(),
    }));
  const more =
    envelopes.length > ENVELOPES_PER_MESSAGE
      ? "More documents are waiting in your dashboard."
      : "";
  return {
    ...withUserEmailLegalFooter(
      {
        textBody: [
          greeting,
          "",
          intro,
          "",
          ...documents.map(({ title, url }) => `- ${title} (${url})`),
          ...(more ? ["", more] : []),
          "",
          `Open your dashboard: ${dashboard}`,
        ].join("\n"),
        htmlBody: [
          `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(intro)}</p><ul>`,
          ...documents.map(
            ({ title, url }) =>
              `<li><a href="${escapeHtml(url)}">${escapeHtml(title)}</a></li>`,
          ),
          "</ul>",
          ...(more ? [`<p>${escapeHtml(more)}</p>`] : []),
          `<p><a href="${escapeHtml(dashboard)}">Open your dashboard</a></p>`,
        ].join(""),
      },
      branding,
      env,
    ),
    subject: "Documents waiting for signatures or approvals",
    template: "sender_daily_digest",
    to: sender.email,
  };
}

export async function sendSenderDigests({
  database,
  emailService,
  env,
  now,
  outOfTime,
}: {
  database: DbPool;
  emailService: () => EmailService;
  env: EnvSource;
  now: number;
  outOfTime: () => boolean;
}): Promise<{ failures: string[]; sent: number; stoppedEarly: boolean }> {
  const summary = { failures: [] as string[], sent: 0, stoppedEarly: false };
  const date = new Date(now * 1000).toISOString().slice(0, 10);
  const keyPrefix = `sender-daily-digest/${date}/`;
  const windowMs = (DAY_SECONDS - (now % DAY_SECONDS)) * 1000;
  let branding: Branding | undefined;
  let afterId = "";

  while (!outOfTime()) {
    // The limiter stores SHA-256 keys. Skipping committed claims here gives
    // a same-day retry its whole budget for senders it has yet to reach.
    const senders = await queryMany<{ id: string }>(
      database,
      `SELECT u.id FROM "user" u
       WHERE u.id > $2 AND ${eligibleSender}
         AND NOT EXISTS (
           SELECT 1 FROM rate_limits r
           WHERE r.key = encode(sha256(convert_to($3 || u.id, 'UTF8')), 'hex')
             AND r.count > 0 AND r.expires_at > $4
         )
         AND EXISTS (
           SELECT 1 FROM envelopes e
           WHERE e.user_id = u.id AND ${outstanding}
         )
       ORDER BY u.id LIMIT ${SENDERS_PER_BATCH}`,
      [now, afterId, keyPrefix, now * 1000],
    );
    for (const { id } of senders) {
      if (outOfTime()) return { ...summary, stoppedEarly: true };

      const key = keyPrefix + id;
      try {
        const sent = await withTransaction(async (tx) => {
          const envelopes = await queryMany<DigestEnvelope>(
            tx,
            `SELECT e.id, e.title, u.email, u.name
             FROM envelopes e JOIN "user" u ON u.id = e.user_id
             WHERE u.id = $2 AND ${eligibleSender} AND ${outstanding}
             ORDER BY e.sent_at ASC NULLS LAST, e.id
             LIMIT ${ENVELOPES_PER_MESSAGE + 1}`,
            [now, id],
          );
          if (envelopes.length === 0) return false;

          // This is a one-email-per-UTC-day limit. Keep the claim only when
          // mail succeeds. The provider key also protects a retry when mail
          // went out just before the transaction was interrupted.
          const claim = await consumeRateLimit(
            { key, limit: 1, now: now * 1000, windowMs },
            { database: tx },
          );
          if (claim.countedIn !== "database") {
            throw new Error("Could not reserve the sender digest in Postgres.");
          }
          if (!claim.allowed) return false;

          branding ??= buildBranding(
            resolveSettings(await readStoredSettings(tx), env),
          );
          await emailService().send(
            buildDigest(envelopes[0]!, envelopes, branding, env),
            { idempotencyKey: key },
          );
          return true;
        }, database);
        if (sent) summary.sent += 1;
      } catch (error) {
        summary.failures.push(id);
        console.error(`Daily digest failed for sender ${id}:`, error);
      }
      afterId = id;
    }

    if (senders.length < SENDERS_PER_BATCH) return summary;
  }

  return { ...summary, stoppedEarly: true };
}
