import { after } from "next/server";

import { onAuditEventCommitted } from "../services/audit.ts";
import type { EnvSource } from "../utils/env.ts";
import { runNotificationJob } from "./job.ts";
import { runUntilCaughtUp, type KickState } from "./kick-loop.ts";
import { getNotificationChannels } from "./registry.ts";
import { peekNotificationSettings } from "./store.ts";

// Delivery soon after something happens, instead of waiting for the next
// scheduled run. Once the server starts (instrumentation.ts), every
// committed envelope audit event asks for a short run of the outbox after
// the response has gone (after(), which keeps a Vercel function alive
// until it is done). Only one run goes at a time in an instance; asking
// while one is going makes it go round once more.
//
// This is only a shortcut. The events are already queued in the database,
// so a run that never happens (a function stopped early, an instance that
// went away) is made up for by the next request or the scheduled run.

const RUN_BUDGET_MS = 15_000;

declare global {
  var __signudocNotificationKick: KickState | undefined;
}

function state(): KickState {
  globalThis.__signudocNotificationKick ??= {
    again: false,
    registered: false,
    running: false,
  };

  return globalThis.__signudocNotificationKick;
}

/**
 * Whether a channel might be set up, without asking the database. True
 * while the settings have not been read in this instance yet: the run
 * itself finds out.
 */
function mightHaveChannel(env: EnvSource): boolean {
  const stored = peekNotificationSettings();

  return (
    stored === null ||
    getNotificationChannels().some(
      (channel) => channel.status({ env, stored }).configured,
    )
  );
}

function runUntilCaughtUpHere() {
  return runUntilCaughtUp(state(), () =>
    runNotificationJob({
      deadline: Date.now() + RUN_BUDGET_MS,
      detectConditions: false,
    }),
  );
}

export function requestNotificationDelivery(env: EnvSource = process.env) {
  if (!mightHaveChannel(env)) {
    return;
  }

  try {
    after(runUntilCaughtUpHere);
  } catch {
    // Not inside a request: nothing to wait for.
    void runUntilCaughtUpHere();
  }
}

/** Called once when the server starts. */
export function registerNotificationDelivery() {
  const current = state();

  if (current.registered) {
    return;
  }

  current.registered = true;
  onAuditEventCommitted(() => {
    requestNotificationDelivery();
  });
}
