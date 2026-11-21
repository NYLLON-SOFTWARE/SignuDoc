import assert from "node:assert/strict";
import { test } from "node:test";

import {
  matchNotificationTargets,
  ruleMatches,
  type NotificationRuleRecord,
  type TargetInput,
} from "./targets.ts";

// Who an event goes to: the rules' channels and the sender's own choices.

const slack = { configured: true, directMessages: true, id: "slack" };

function rule(
  overrides: Partial<NotificationRuleRecord>,
): NotificationRuleRecord {
  return {
    channel: "slack",
    destination: "C0ALL",
    enabled: true,
    events: ["envelope_completed"],
    id: "rule-all",
    ...overrides,
  };
}

function input(overrides: Partial<TargetInput> = {}): TargetInput {
  return {
    channels: [slack],
    envelope: { isDraft: false, ownerId: "owner" },
    kind: "envelope_completed",
    preferences: [],
    rules: [],
    ...overrides,
  };
}

function describe(targets: ReturnType<typeof matchNotificationTargets>) {
  return targets
    .map((target) => `${target.targetKind}:${target.target}`)
    .sort();
}

test("the sender gets the events that are on by default, and no one else does", () => {
  assert.deepEqual(describe(matchNotificationTargets(input())), ["user:owner"]);
  assert.deepEqual(
    describe(matchNotificationTargets(input({ kind: "envelope_viewed" }))),
    [],
  );
});

test("the sender can turn an event off, or one on", () => {
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          preferences: [
            {
              channel: "slack",
              enabled: false,
              event: "envelope_completed",
              userId: "owner",
            },
          ],
        }),
      ),
    ),
    [],
  );
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          kind: "envelope_viewed",
          preferences: [
            {
              channel: "slack",
              enabled: true,
              event: "envelope_viewed",
              userId: "owner",
            },
          ],
        }),
      ),
    ),
    ["user:owner"],
  );

  // Someone else's choice says nothing about the sender's.
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          preferences: [
            {
              channel: "slack",
              enabled: false,
              event: "envelope_completed",
              userId: "someone-else",
            },
          ],
        }),
      ),
    ),
    ["user:owner"],
  );
});

test("a rule posts the events it names, and never a draft", () => {
  assert.deepEqual(
    describe(matchNotificationTargets(input({ rules: [rule({})] }))),
    ["channel:C0ALL", "user:owner"],
  );
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({ kind: "envelope_signed", rules: [rule({})] }),
      ),
    ),
    ["user:owner"],
  );
  assert.deepEqual(
    describe(
      matchNotificationTargets(input({ rules: [rule({ enabled: false })] })),
    ),
    ["user:owner"],
  );

  const draft = input({
    envelope: { isDraft: true, ownerId: "owner" },
    rules: [rule({})],
  });

  assert.equal(ruleMatches(rule({}), draft), false);
  // A draft is the sender's alone.
  assert.deepEqual(describe(matchNotificationTargets(draft)), ["user:owner"]);
});

test("nothing goes to a channel that is not set up, and no direct messages when they are off", () => {
  assert.deepEqual(
    matchNotificationTargets(
      input({
        channels: [{ configured: false, directMessages: false, id: "slack" }],
        rules: [rule({})],
      }),
    ),
    [],
  );
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          channels: [{ configured: true, directMessages: false, id: "slack" }],
          rules: [rule({})],
        }),
      ),
    ),
    ["channel:C0ALL"],
  );
});

test("two rules for the same channel make one delivery", () => {
  const targets = matchNotificationTargets(
    input({
      rules: [
        rule({}),
        rule({ events: ["envelope_completed", "envelope_declined"], id: "b" }),
      ],
    }),
  );

  assert.deepEqual(describe(targets), ["channel:C0ALL", "user:owner"]);
  assert.equal(
    targets.find((target) => target.targetKind === "channel")?.ruleId,
    "rule-all",
  );
});

test("nobody hears about what they did themselves, but channels still do", () => {
  const people = { owner: "Sam@Example.com" };
  const signedByOwner = input({
    actorEmails: ["sam@example.com"],
    kind: "envelope_signed",
    rules: [rule({ events: ["envelope_signed"] })],
    userEmails: people,
  });

  assert.deepEqual(describe(matchNotificationTargets(signedByOwner)), [
    "channel:C0ALL",
  ]);

  // Someone else signing: the sender hears about it.
  assert.deepEqual(
    describe(
      matchNotificationTargets({
        ...signedByOwner,
        actorEmails: ["alex@example.com"],
      }),
    ),
    ["channel:C0ALL", "user:owner"],
  );

  // An outcome is news even to whoever finished it: the sender who signs
  // last still hears that the envelope is complete.
  assert.deepEqual(
    describe(
      matchNotificationTargets(
        input({
          actorEmails: ["sam@example.com"],
          kind: "envelope_completed",
          userEmails: people,
        }),
      ),
    ),
    ["user:owner"],
  );
});
