/**
 * Indexer backpressure + cancellable watermark scheduler (#323)
 *
 * Covers the four acceptance criteria: poll ticks never overlap under overrun,
 * stop() cancels cleanly, sustained overrun applies and then relieves
 * backpressure, and a long soak stays bounded in memory.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { WatermarkScheduler } from "../src/services/indexer-scheduler.js";

/**
 * Deterministic clock. Timers fire only when the test advances time, so these
 * assertions never depend on real scheduling latency.
 */
function createFakeClock(startMs = 0) {
  let current = startMs;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => current,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { fireAt: current + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Move time forward, firing every timer whose deadline has passed. */
    async advance(ms) {
      const target = current + ms;
      // Re-scan after each fire: a callback schedules the next tick.
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.fireAt <= target && (due === null || timer.fireAt < due[1].fireAt)) {
            due = [id, timer];
          }
        }
        if (due === null) break;
        const [id, timer] = due;
        timers.delete(id);
        current = Math.max(current, timer.fireAt);
        timer.callback();
        // Drain the microtask queue so a cycle that resolves immediately has
        // fully unwound (including its `finally`) before the next tick fires.
        await new Promise((resolve) => setImmediate(resolve));
      }
      current = target;
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

/** A promise plus its resolver, for holding a cycle open. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("overrunning ticks never start an overlapping cycle", async () => {
  const clock = createFakeClock();
  const gate = deferred();
  let concurrent = 0;
  let maxConcurrent = 0;
  let started = 0;
  const overruns = [];

  const scheduler = new WatermarkScheduler({
    intervalMs: 100,
    clock,
    // Keep backpressure out of this assertion so the cadence stays fixed.
    maxConsecutiveOverruns: Number.POSITIVE_INFINITY,
    runCycle: async () => {
      started += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate.promise;
      concurrent -= 1;
    },
    onOverrun: (skipped, reason) => overruns.push({ skipped, reason }),
  });

  scheduler.start();
  await clock.advance(100); // first cycle starts and blocks on the gate
  assert.equal(started, 1);

  // Five more ticks arrive while the first cycle is still in flight.
  await clock.advance(500);

  assert.equal(started, 1, "no second cycle may start while one is active");
  assert.equal(maxConcurrent, 1);
  assert.ok(overruns.length >= 5, "each dropped tick is reported as an overrun");
  assert.ok(
    overruns.every((o) => o.reason === "in_flight"),
    "overruns during an active cycle are attributed to the in-flight cycle",
  );

  gate.resolve();
  await scheduler.stop();

  assert.equal(scheduler.stats().cyclesStarted, 1);
  assert.equal(scheduler.stats().skippedPolls, overruns.reduce((n, o) => n + o.skipped, 0));
});

test("stop() aborts the in-flight cycle and resolves only once it settles", async () => {
  const clock = createFakeClock();
  let observedAbort = null;
  let settled = false;

  const scheduler = new WatermarkScheduler({
    intervalMs: 50,
    clock,
    runCycle: (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = signal.reason;
          settled = true;
          reject(signal.reason);
        });
      }),
    onError: () => assert.fail("an aborted cycle must not surface as an error"),
  });

  scheduler.start();
  await clock.advance(50);
  assert.equal(scheduler.isCycleActive, true);

  await scheduler.stop();

  assert.equal(settled, true, "stop() waits for the cycle to unwind");
  assert.ok(observedAbort instanceof Error);
  assert.match(observedAbort.message, /scheduler stopped/i);
  assert.equal(scheduler.isCycleActive, false);
  assert.equal(scheduler.isRunning, false);
  assert.equal(clock.pendingTimers, 0, "no timer outlives stop()");

  // Idempotent: a second stop is a no-op rather than a throw.
  await scheduler.stop();
});

test("sustained overrun widens the interval, and on-time cycles narrow it again", async () => {
  const clock = createFakeClock();
  let gate = deferred();
  const levels = [];

  const scheduler = new WatermarkScheduler({
    intervalMs: 100,
    clock,
    maxConsecutiveOverruns: 2,
    backpressureFactor: 2,
    maxIntervalMs: 800,
    recoveryCycles: 2,
    runCycle: async () => {
      await gate.promise;
    },
    onBackpressure: (stats) => levels.push(stats.backpressureLevel),
  });

  scheduler.start();
  await clock.advance(100); // cycle 1 starts, blocks
  await clock.advance(200); // two ticks dropped -> level 1

  assert.equal(scheduler.stats().backpressureLevel, 1);
  assert.equal(scheduler.currentIntervalMs, 200);

  gate.resolve();
  await scheduler.drain();

  // Now let cycles complete promptly; the interval should step back down.
  gate = deferred();
  gate.resolve();
  await clock.advance(1000);

  assert.equal(scheduler.stats().backpressureLevel, 0);
  assert.equal(scheduler.currentIntervalMs, 100);
  assert.deepEqual(levels, [1, 0]);

  await scheduler.stop();
});

test("a saturated downstream queue sheds ticks before any work starts", async () => {
  const clock = createFakeClock();
  let depth = 0;
  let started = 0;
  const reasons = [];

  const scheduler = new WatermarkScheduler({
    intervalMs: 100,
    clock,
    getQueueDepth: () => depth,
    maxQueueDepth: 10,
    maxConsecutiveOverruns: Number.POSITIVE_INFINITY,
    runCycle: async () => {
      started += 1;
    },
    onOverrun: (_skipped, reason) => reasons.push(reason),
  });

  scheduler.start();
  await clock.advance(100);
  assert.equal(started, 1, "a drained queue lets the cycle run");

  depth = 25; // verification backlog is over the ceiling
  await clock.advance(300);

  assert.equal(started, 1, "no cycle starts while the queue is saturated");
  assert.equal(scheduler.stats().shedPolls, 3);
  assert.deepEqual(reasons, ["queue_full", "queue_full", "queue_full"]);

  depth = 0; // backlog drained
  await clock.advance(100);
  assert.equal(started, 2, "the loop resumes once the queue drains");

  await scheduler.stop();
});

test("a broken queue-depth probe does not stall the loop", async () => {
  const clock = createFakeClock();
  let started = 0;

  const scheduler = new WatermarkScheduler({
    intervalMs: 100,
    clock,
    getQueueDepth: () => {
      throw new Error("probe unavailable");
    },
    maxQueueDepth: 1,
    runCycle: async () => {
      started += 1;
    },
  });

  scheduler.start();
  await clock.advance(200);
  assert.ok(started >= 1, "a failing probe is treated as an empty queue");

  await scheduler.stop();
});

test("a long soak under permanent overrun keeps memory bounded", async () => {
  const clock = createFakeClock();
  const gate = deferred();

  const scheduler = new WatermarkScheduler({
    intervalMs: 10,
    clock,
    maxIntervalMs: 10, // pin the cadence so every tick really does overrun
    maxConsecutiveOverruns: Number.POSITIVE_INFINITY,
    runCycle: async () => {
      await gate.promise;
    },
  });

  scheduler.start();
  await clock.advance(10); // one cycle starts and never finishes

  if (globalThis.gc) globalThis.gc();
  const rssBefore = process.memoryUsage().rss;

  // 20k ticks all land on an occupied slot. A queueing scheduler would retain
  // 20k pending cycles; this one drops them, so RSS must not track tick count.
  await clock.advance(200_000);

  if (globalThis.gc) globalThis.gc();
  const rssAfter = process.memoryUsage().rss;
  const growthMb = (rssAfter - rssBefore) / (1024 * 1024);

  assert.equal(scheduler.stats().cyclesStarted, 1);
  assert.ok(
    scheduler.stats().skippedPolls >= 19_000,
    `expected the soak to drop ~20k ticks, dropped ${scheduler.stats().skippedPolls}`,
  );
  assert.ok(
    growthMb < 32,
    `RSS grew ${growthMb.toFixed(1)} MiB across 20k shed ticks; the scheduler is retaining work`,
  );
  assert.equal(clock.pendingTimers, 1, "exactly one timer is ever outstanding");

  gate.resolve();
  await scheduler.stop();
});
