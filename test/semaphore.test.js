import test from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "../src/semaphore.js";

test("validates limits and releases semaphore slots only once", async () => {
  assert.throws(() => createSemaphore(0), /positive integer/i);
  assert.throws(() => createSemaphore(1.5), /positive integer/i);

  const semaphore = createSemaphore(1);
  const release = await semaphore.acquire();
  assert.equal(semaphore.activeCount, 1);
  release();
  release();
  assert.equal(semaphore.activeCount, 0);
});

test("removes an aborted waiter and admits the next queued acquisition", async () => {
  const semaphore = createSemaphore(1);
  const releaseActive = await semaphore.acquire();
  const cancelled = new AbortController();
  const cancelledWaiter = semaphore.acquire(cancelled.signal);
  const nextWaiter = semaphore.acquire();
  assert.equal(semaphore.queuedCount, 2);

  cancelled.abort();
  await assert.rejects(cancelledWaiter, { name: "AbortError" });
  assert.equal(semaphore.queuedCount, 1);

  releaseActive();
  const releaseNext = await nextWaiter;
  assert.equal(semaphore.activeCount, 1);
  releaseNext();
  assert.equal(semaphore.activeCount, 0);
});
