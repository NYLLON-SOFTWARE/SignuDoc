import type { NotificationJobSummary } from "./job.ts";

// The loop behind the after-request kick (kick.ts), without the parts that
// need a running server, so it can be tested with a fake run.

/** How many times a run waits for a delivery that is due soon. */
const MAX_WAITS = 3;
const WAIT_MARGIN_MS = 1_000;
/** The most rounds one kick makes, so a backlog that never fits cannot spin. */
const MAX_ROUNDS = 10;

export type KickState = {
  again: boolean;
  registered: boolean;
  running: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runUntilCaughtUp(
  current: KickState,
  run: () => Promise<NotificationJobSummary>,
  wait: (ms: number) => Promise<void> = sleep,
) {
  if (current.running) {
    current.again = true;
    return;
  }

  current.running = true;

  try {
    let waits = 0;
    let rounds = 0;

    do {
      current.again = false;
      rounds += 1;

      const summary = await run();

      if (current.again || summary.status !== "ran") {
        continue;
      }

      // A signature waits a minute in case more follow (burst collapse).
      // Wait for it here, a few times at most, rather than leave it to the
      // next scheduled run; whatever is still waiting goes out then.
      if (summary.nextDueAt !== null && waits < MAX_WAITS) {
        waits += 1;
        await wait(
          Math.max(summary.nextDueAt * 1000 - Date.now(), 0) + WAIT_MARGIN_MS,
        );
        current.again = true;
      } else if (summary.stoppedEarly && rounds < MAX_ROUNDS) {
        // Work left: out of time (deliveries put back as due now do not show
        // up as "due soon"), or more events queued than one run expands. Go
        // round again rather than leave it for the next scheduled run, which
        // may be a day away.
        current.again = true;
      }
    } while (current.again);
  } catch (error) {
    console.warn(
      "[notifications] Delivering notifications failed; the next run tries again:",
      error instanceof Error ? error.message : error,
    );
  } finally {
    current.running = false;
  }
}
