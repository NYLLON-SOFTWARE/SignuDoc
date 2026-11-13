import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSharedSerialQueue,
  NobodyWaitingError,
} from "./shared-serial-queue.ts";

type Deferred = {
  promise: Promise<string>;
  reject: (error: Error) => void;
  resolve: (value: string) => void;
};

function defer(): Deferred {
  let resolve: (value: string) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });

  return { promise, reject, resolve };
}

// A queue whose jobs finish only when the test says so.
function createControlledQueue() {
  const started: string[] = [];
  const deferred = new Map<string, Deferred>();
  const queue = createSharedSerialQueue((key) => {
    const job = defer();

    started.push(key);
    deferred.set(key, job);

    return job.promise;
  });

  return {
    finish(key: string) {
      deferred.get(key)?.resolve(`${key} done`);
    },
    fail(key: string) {
      deferred.get(key)?.reject(new Error(`${key} failed`));
    },
    queue,
    started,
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("runs one job at a time, in the order they were asked for", async () => {
  const { finish, queue, started } = createControlledQueue();
  const first = queue.request("a");
  const second = queue.request("b");

  await settle();
  assert.deepEqual(started, ["a"]);

  finish("a");
  assert.equal(await first.result, "a done");
  await settle();
  assert.deepEqual(started, ["a", "b"]);

  finish("b");
  assert.equal(await second.result, "b done");
});

test("gives everyone who asks for the same key the same job", async () => {
  const { finish, queue, started } = createControlledQueue();
  const first = queue.request("a");
  const second = queue.request("a");

  await settle();
  finish("a");

  assert.equal(await first.result, "a done");
  assert.equal(await second.result, "a done");
  assert.deepEqual(started, ["a"]);
});

test("drops a waiting job once nobody wants it, and moves on", async () => {
  const { finish, queue, started } = createControlledQueue();
  const first = queue.request("a");
  const unwanted = queue.request("b");
  const third = queue.request("c");

  unwanted.release();
  // Releasing twice must not count against anyone else.
  unwanted.release();

  await settle();
  finish("a");
  await first.result;

  await assert.rejects(unwanted.result, NobodyWaitingError);
  await settle();
  assert.deepEqual(started, ["a", "c"]);

  finish("c");
  assert.equal(await third.result, "c done");
});

test("keeps a waiting job while at least one caller still wants it", async () => {
  const { finish, queue, started } = createControlledQueue();
  const first = queue.request("a");
  const gone = queue.request("b");
  const stillHere = queue.request("b");

  gone.release();

  await settle();
  finish("a");
  await first.result;
  await settle();
  assert.deepEqual(started, ["a", "b"]);

  finish("b");
  assert.equal(await stillHere.result, "b done");
});

test("finishes a job that has started even if its caller leaves", async () => {
  const { finish, queue, started } = createControlledQueue();
  const first = queue.request("a");

  await settle();
  first.release();
  finish("a");

  assert.equal(await first.result, "a done");
  assert.deepEqual(started, ["a"]);
});

test("a job that fails does not hold up the ones behind it", async () => {
  const { fail, finish, queue } = createControlledQueue();
  const first = queue.request("a");
  const second = queue.request("b");

  await settle();
  fail("a");
  await assert.rejects(first.result, /a failed/);

  await settle();
  finish("b");
  assert.equal(await second.result, "b done");
});

test("asking again after a job has finished starts a new one", async () => {
  const { finish, queue, started } = createControlledQueue();
  const first = queue.request("a");

  await settle();
  finish("a");
  await first.result;

  const again = queue.request("a");

  // The earlier caller letting go late must not drop the new job.
  first.release();

  await settle();
  assert.deepEqual(started, ["a", "a"]);

  finish("a");
  assert.equal(await again.result, "a done");
});
