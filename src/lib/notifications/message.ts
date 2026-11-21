import type { NotificationEventKind } from "./events.ts";

// What a notification says, before any one chat tool lays it out. It names
// the envelope by its title, says what happened and who did it, where the
// envelope stands, and links to it in this app. Nothing from the document
// itself and no decline reason is ever in it: whoever can read the
// channel is sent to the app, which checks who they are, for anything more.
//
// Copy is short and plain: "Alex Chen signed Acme MSA — 2 of 3 signed". No
// exclamation marks.

export type NotificationEnvelope = {
  expiresAt: number | null;
  id: string;
  ownerEmail: string;
  ownerName: string;
  signedCount: number;
  signerCount: number;
  status: string;
  title: string;
};

/** Who did it, from the queued event. Never anything else. */
export type NotificationPayload = {
  actorEmail?: string;
  expiresAt?: number;
  idleDays?: number;
  signerEmail?: string;
  signerName?: string;
};

/** How a message is coloured and marked: what kind of news it is. */
export type NotificationTone =
  "danger" | "neutral" | "progress" | "success" | "warning";

/** Part of a headline. `strong` parts (the envelope's title) are bold. */
export type HeadlinePart = { strong?: boolean; text: string };

export type NotificationAction = {
  id: "certificate" | "open" | "remind";
  label: string;
  primary?: boolean;
  url: string;
};

/** Who the message is for and what it is called. */
export type NotificationBrand = {
  /** The logo as an absolute https address, or null. */
  logoUrl: string | null;
  name: string;
};

export type NotificationMessage = {
  actions: NotificationAction[];
  brand: NotificationBrand;
  /** Short facts shown under the headline, in order. Plain text. */
  details: string[];
  /** One sentence: what happened. Plain text, unescaped. */
  headline: HeadlinePart[];
  kind: NotificationEventKind;
  /** When it happened, seconds since the epoch, or null. */
  occurredAt: number | null;
  /** "2 of 3 signed", or null when there is no one to sign. */
  progress: string | null;
  tone: NotificationTone;
  /** Everything in one line, for notifications and tools without layout. */
  text: string;
};

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  declined: "Declined",
  draft: "Draft",
  expired: "Expired",
  sent: "Out for signature",
  voided: "Voided",
};

export const NOTIFICATION_TONES: Record<
  NotificationEventKind,
  NotificationTone
> = {
  envelope_completed: "success",
  envelope_declined: "danger",
  envelope_expired: "danger",
  envelope_expiring_soon: "warning",
  envelope_sent: "progress",
  envelope_signed: "progress",
  envelope_stuck: "warning",
  envelope_viewed: "progress",
  envelope_voided: "neutral",
};

function personName(
  name: string | undefined,
  email: string | undefined,
  fallback: string,
): string {
  return name?.trim() || email?.trim() || fallback;
}

export function formatNotificationDate(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(unixSeconds * 1000));
}

function progressOf(envelope: NotificationEnvelope | null): string | null {
  if (!envelope || envelope.signerCount <= 0) {
    return null;
  }

  return `${String(envelope.signedCount)} of ${String(envelope.signerCount)} signed`;
}

function headlineFor(
  kind: NotificationEventKind,
  envelope: NotificationEnvelope | null,
  payload: NotificationPayload,
  progress: string | null,
): HeadlinePart[] {
  const title: HeadlinePart = envelope
    ? { strong: true, text: envelope.title }
    : { text: "An envelope" };
  const signer = personName(
    payload.signerName,
    payload.signerEmail,
    "A signer",
  );
  const sender = envelope?.ownerName || envelope?.ownerEmail || "Someone";
  const withProgress = (parts: HeadlinePart[]) =>
    progress ? [...parts, { text: ` — ${progress}` }] : parts;

  switch (kind) {
    case "envelope_sent":
      return [{ text: `${sender} sent ` }, title, { text: " for signature" }];
    case "envelope_viewed":
      return [{ text: `${signer} opened ` }, title];
    case "envelope_signed":
      return withProgress([{ text: `${signer} signed ` }, title]);
    case "envelope_completed":
      return [title, { text: " is complete — everyone has signed" }];
    case "envelope_declined":
      return [{ text: `${signer} declined to sign ` }, title];
    case "envelope_voided":
      return [title, { text: " was voided" }];
    case "envelope_expired":
      return withProgress([title, { text: " expired before everyone signed" }]);
    case "envelope_expiring_soon": {
      const at = payload.expiresAt ?? envelope?.expiresAt ?? null;

      return withProgress([
        title,
        {
          text:
            at === null
              ? " expires soon"
              : ` expires on ${formatNotificationDate(at)}`,
        },
      ]);
    }
    case "envelope_stuck":
      return [
        title,
        {
          text: payload.idleDays
            ? ` has had no activity for ${String(payload.idleDays)} days`
            : " has had no activity for a while",
        },
      ];
  }
}

/** The headline as one plain line. */
export function headlineText(headline: HeadlinePart[]): string {
  return headline.map((part) => part.text).join("");
}

/** Whether the progress is already said in the headline. */
function progressInHeadline(kind: NotificationEventKind): boolean {
  return (
    kind === "envelope_signed" ||
    kind === "envelope_expired" ||
    kind === "envelope_expiring_soon"
  );
}

export const DEFAULT_NOTIFICATION_BRAND: NotificationBrand = {
  logoUrl: null,
  name: "SignuDoc",
};

/**
 * The message for one event. `appUrl` is this site's address, without
 * which there are no buttons. `forSender` is true when it goes to the
 * envelope's sender themselves, who alone gets "Send reminder".
 */
export function buildNotificationMessage({
  appUrl,
  brand = DEFAULT_NOTIFICATION_BRAND,
  envelope,
  forSender = false,
  kind,
  occurredAt = null,
  payload,
}: {
  appUrl: string | null;
  brand?: NotificationBrand;
  envelope: NotificationEnvelope | null;
  forSender?: boolean;
  kind: NotificationEventKind;
  occurredAt?: number | null;
  payload: NotificationPayload;
}): NotificationMessage {
  const progress = progressOf(envelope);
  const headline = headlineFor(kind, envelope, payload, progress);
  const base = appUrl?.replace(/\/+$/, "") ?? null;
  const details: string[] = [];
  const actions: NotificationAction[] = [];

  if (envelope) {
    // An envelope that ran out of time keeps the stored status "sent".
    const expired = kind === "envelope_expired";

    details.push(
      expired ? "Expired" : (STATUS_LABELS[envelope.status] ?? envelope.status),
    );

    if (progress && !progressInHeadline(kind)) {
      details.push(progress);
    }

    if (kind !== "envelope_sent") {
      details.push(
        `Sent by ${envelope.ownerName || envelope.ownerEmail || "someone"}`,
      );
    }

    if (
      envelope.expiresAt !== null &&
      !expired &&
      envelope.status === "sent" &&
      kind !== "envelope_expiring_soon"
    ) {
      details.push(`Due ${formatNotificationDate(envelope.expiresAt)}`);
    }

    if (base) {
      const envelopeUrl = `${base}/envelopes/${encodeURIComponent(envelope.id)}`;

      if (kind === "envelope_completed") {
        actions.push({
          id: "certificate",
          label: "View certificate",
          primary: true,
          // Through a page, so an expired session is asked to sign in.
          url: `${envelopeUrl}/certificate`,
        });
      }

      if (
        forSender &&
        envelope.status === "sent" &&
        (kind === "envelope_stuck" || kind === "envelope_expiring_soon")
      ) {
        actions.push({
          id: "remind",
          label: "Send reminder",
          primary: true,
          url: envelopeUrl,
        });
      }

      actions.push({ id: "open", label: "Open envelope", url: envelopeUrl });
    }
  }

  const text = [headlineText(headline), ...details].join(" · ");

  return {
    actions,
    brand,
    details,
    headline,
    kind,
    occurredAt,
    progress,
    text,
    tone: NOTIFICATION_TONES[kind],
  };
}

/** Reads a queued event's payload, keeping only the fields it may hold. */
export function readNotificationPayload(raw: unknown): NotificationPayload {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }

  const value = raw as Record<string, unknown>;
  const payload: NotificationPayload = {};

  for (const key of ["actorEmail", "signerEmail", "signerName"] as const) {
    const field = value[key];

    if (typeof field === "string" && field.trim()) {
      payload[key] = field.trim().slice(0, 320);
    }
  }

  for (const key of ["expiresAt", "idleDays"] as const) {
    const field = value[key];

    if (typeof field === "number" && Number.isFinite(field)) {
      payload[key] = field;
    }
  }

  return payload;
}
