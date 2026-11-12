// A queue for slow work that several parts of a page may ask for at once,
// such as drawing a thumbnail from a PDF. It does three things:
//
//   - runs one job at a time, in the order they were first asked for;
//   - gives everyone who asks for the same key the same job;
//   - drops a job that has not started once nobody is waiting for it.
//
// A job that has started always finishes: its result may still be useful to
// whoever asks next.

export type SharedQueueRequest<T> = {
  /**
   * Says the caller no longer needs the result. Safe to call more than once,
   * and after the job has finished.
   */
  release: () => void;
  result: Promise<T>;
};

/** What a job that was dropped before it started rejects with. */
export class NobodyWaitingError extends Error {
  constructor(key: string) {
    super(`Nobody is waiting for "${key}" any more.`);
    this.name = "NobodyWaitingError";
  }
}

type QueuedJob<T> = {
  result: Promise<T>;
  waiting: { count: number };
};

export function createSharedSerialQueue<T>(run: (key: string) => Promise<T>) {
  const jobs = new Map<string, QueuedJob<T>>();
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue(key: string): QueuedJob<T> {
    const waiting = { count: 0 };
    const result = tail
      .then(() => {
        if (waiting.count === 0) {
          throw new NobodyWaitingError(key);
        }

        return run(key);
      })
      .finally(() => {
        jobs.delete(key);
      });
    const job = { result, waiting };

    // The next job starts when this one settles, whichever way it goes.
    tail = result.catch(() => undefined);
    jobs.set(key, job);

    return job;
  }

  return {
    request(key: string): SharedQueueRequest<T> {
      const job = jobs.get(key) ?? enqueue(key);
      let released = false;

      job.waiting.count += 1;

      return {
        release() {
          if (released) {
            return;
          }

          released = true;
          job.waiting.count -= 1;
        },
        result: job.result,
      };
    },
  };
}
