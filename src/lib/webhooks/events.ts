import type { AuditEventType } from "../types/domain.ts";

// The events a webhook endpoint can receive, and the audit event each one
// comes from. Every one of them is already written to an envelope's audit
// trail, so a webhook says nothing the trail does not.

export const webhookEventTypes = [
  "envelope.sent",
  "signer.viewed",
  "signer.signed",
  "envelope.completed",
  "envelope.declined",
  "envelope.voided",
  "envelope.expired",
] as const;

export type WebhookEventType = (typeof webhookEventTypes)[number];

/** Sent only by the "Send test" button, never by an envelope. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

// An approver's approval is reported as their signature and a rejection as
// a decline, which is how each moves the envelope on or ends it. The signer
// in the payload has role "approver".
const fromAuditEvent: Partial<Record<AuditEventType, WebhookEventType>> = {
  approved: "signer.signed",
  completed: "envelope.completed",
  declined: "envelope.declined",
  expired: "envelope.expired",
  rejected: "envelope.declined",
  sent: "envelope.sent",
  signed: "signer.signed",
  viewed: "signer.viewed",
  voided: "envelope.voided",
};

/** The webhook event an audit event becomes, or null for one that has none. */
export function webhookEventForAuditEvent(
  event: AuditEventType,
): WebhookEventType | null {
  return fromAuditEvent[event] ?? null;
}

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return (
    typeof value === "string" &&
    (webhookEventTypes as readonly string[]).includes(value)
  );
}

/** A list of event types from a request: known ones, each once, in order. */
export function parseWebhookEventTypes(
  value: unknown,
): WebhookEventType[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  if (!value.every(isWebhookEventType)) {
    return null;
  }

  return webhookEventTypes.filter((type) => value.includes(type));
}
