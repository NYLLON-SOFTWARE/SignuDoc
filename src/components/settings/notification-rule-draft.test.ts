import assert from "node:assert/strict";
import test from "node:test";

import {
  draftFromRule,
  EMPTY_RULE,
  ruleBody,
} from "./notification-rule-draft.ts";

const rule = {
  destination: "C123",
  destinationName: "#sales",
  events: ["envelope_completed" as const],
  id: "rule-1",
};

test("saving an edit does not send enabled, so the stored state is kept", () => {
  // A rule paused while its edit form is open must stay paused: the draft
  // was taken when it was active and must not put that back.
  const body = ruleBody(draftFromRule({ ...rule }));

  assert.equal("enabled" in body, false);
});

test("a new rule is created enabled", () => {
  assert.equal((ruleBody(EMPTY_RULE) as { enabled?: boolean }).enabled, true);
});
