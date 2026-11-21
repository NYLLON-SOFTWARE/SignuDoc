import {
  NOTIFICATION_EVENTS,
  SELF_ACTION_KINDS,
  type NotificationEventKind,
} from "./events.ts";

// Who an event goes to, worked out from what is already known about it.
// No database and no chat tool here, so every case can be tested on its
// own (targets.test.ts); outbox.ts gathers the inputs.
//
// * A rule sends to its channel when it names the event and its chat tool
//   is set up. A draft is never announced in a channel.
// * The sender of an envelope gets a direct message for the events that
//   are on by default, unless they turned that event off, and for the
//   others they turned on.
// * Nobody hears about what they did themselves: a sender who signs their
//   own envelope gets no "you signed" message. A person is matched to the
//   event by email address. Channels still hear about it.

export type NotificationRuleRecord = {
  channel: string;
  destination: string;
  enabled: boolean;
  events: string[];
  id: string;
};

export type NotificationPreferenceRecord = {
  channel: string;
  enabled: boolean;
  event: string;
  userId: string;
};

export type ChannelAvailability = {
  configured: boolean;
  directMessages: boolean;
  id: string;
};

export type NotificationTarget = {
  channel: string;
  ruleId: string | null;
  target: string;
  targetKind: "channel" | "user";
};

export type TargetInput = {
  channels: ChannelAvailability[];
  envelope: {
    isDraft: boolean;
    ownerId: string;
  };
  kind: NotificationEventKind;
  preferences: NotificationPreferenceRecord[];
  rules: NotificationRuleRecord[];
  /** Who did it (the event's actor and signer), lower-case email addresses. */
  actorEmails?: string[];
  /** The email address of each person who might get a direct message, by id. */
  userEmails?: Record<string, string>;
};

export function preferenceFor(
  preferences: NotificationPreferenceRecord[],
  userId: string,
  channel: string,
  event: string,
): boolean | null {
  const found = preferences.find(
    (preference) =>
      preference.userId === userId &&
      preference.channel === channel &&
      preference.event === event,
  );

  return found ? found.enabled : null;
}

export function ruleMatches(
  rule: NotificationRuleRecord,
  input: Pick<TargetInput, "envelope" | "kind">,
): boolean {
  return (
    rule.enabled && rule.events.includes(input.kind) && !input.envelope.isDraft
  );
}

export function matchNotificationTargets(
  input: TargetInput,
): NotificationTarget[] {
  const definition = NOTIFICATION_EVENTS[input.kind];
  const targets = new Map<string, NotificationTarget>();

  const actors = new Set(
    (input.actorEmails ?? []).map((email) => email.trim().toLowerCase()),
  );
  const isActor = (userId: string) => {
    const email = input.userEmails?.[userId]?.trim().toLowerCase();

    return (
      SELF_ACTION_KINDS.has(input.kind) &&
      email !== undefined &&
      email !== "" &&
      actors.has(email)
    );
  };

  function add(target: NotificationTarget) {
    if (target.targetKind === "user" && isActor(target.target)) {
      return;
    }

    const key = `${target.channel}\u0000${target.targetKind}\u0000${target.target}`;

    if (!targets.has(key)) {
      targets.set(key, target);
    }
  }

  for (const channel of input.channels) {
    if (!channel.configured) {
      continue;
    }

    for (const rule of input.rules) {
      if (rule.channel === channel.id && ruleMatches(rule, input)) {
        add({
          channel: channel.id,
          ruleId: rule.id,
          target: rule.destination,
          targetKind: "channel",
        });
      }
    }

    if (!channel.directMessages) {
      continue;
    }

    const ownerId = input.envelope.ownerId;
    const wants =
      preferenceFor(input.preferences, ownerId, channel.id, input.kind) ??
      definition.onByDefault;

    if (wants) {
      add({
        channel: channel.id,
        ruleId: null,
        target: ownerId,
        targetKind: "user",
      });
    }
  }

  return [...targets.values()];
}
