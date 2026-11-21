import assert from "node:assert/strict";
import { test } from "node:test";

import type { NotificationJobSummary } from "./job.ts";
import { runUntilCaughtUp, type KickState } from "./kick-loop.ts";

function ran(stoppedEarly: boolean): NotificationJobSummary {
  return {
    conditions: null,
    delivered: { failed: 0, postponed: 0, sent: 0, skipped: 0 },
    deliveriesCreated: 0,
    eventsProcessed: 0,
    nextDueAt: null,
    purged: 0,
    status: "ran",
    stoppedEarly,
  };
}

function freshState(): KickState {
  return { again: false, registered: false, running: false };
}

test("a run that ran out of time goes round again until it catches up", async () => {
  const answers = [ran(true), ran(false)];
  let calls = 0;

  await runUntilCaughtUp(freshState(), async () => {
    calls += 1;

    return answers.shift() ?? ran(false);
  });

  assert.equal(calls, 2);
});

test("a backlog that never fits does not spin forever", async () => {
  let calls = 0;

  await runUntilCaughtUp(freshState(), async () => {
    calls += 1;

    return ran(true);
  });

  assert.ok(calls >= 2 && calls <= 20, `ran ${String(calls)} times`);
});

test("a run that caught up is not repeated", async () => {
  let calls = 0;

  await runUntilCaughtUp(freshState(), async () => {
    calls += 1;

    return ran(false);
  });

  assert.equal(calls, 1);
});
