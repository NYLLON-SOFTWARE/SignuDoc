import type { NotificationEventKind } from "../../lib/notifications/events.ts";

// The Slack rule form's draft, and the request body saved from it.

export type RuleDraft = {
  destination: string;
  destinationName: string;
  events: NotificationEventKind[];
  id: string | null;
};

export const EMPTY_RULE: RuleDraft = {
  destination: "",
  destinationName: "",
  events: ["envelope_completed", "envelope_declined"],
  id: null,
};

export function draftFromRule(rule: {
  destination: string;
  destinationName: string | null;
  events: NotificationEventKind[];
  id: string;
}): RuleDraft {
  return {
    destination: rule.destination,
    destinationName: rule.destinationName ?? "",
    events: rule.events,
    id: rule.id,
  };
}

export function ruleBody(draft: RuleDraft) {
  // An update leaves enabled out so the rule keeps the state it has now: it
  // may have been paused or resumed since the form was opened.
  return {
    ...(draft.id === null ? { enabled: true } : {}),
    channel: "slack",
    destination: draft.destination,
    destinationName: draft.destinationName || null,
    events: draft.events,
  };
}
