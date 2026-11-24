/**
 * Background worker lifecycle / drain tests.
 *
 * Uses `node:test` + `node:assert/strict` (same convention as the rest of the
 * backend test suite). Exercises the reusable abstraction in isolation, with
 * no Express / database / RPC dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createWorker,
  WorkerRegistry,
  WorkerStopTimeoutError,
  type BackgroundWorker,
} from "../src/services/worker.js";

function recordingWorker(name: string, calls: string[]): BackgroundWorker {
  return {
    name,
    enabled: true,
    async start() {
      calls.push(`start:${name}`);
    },
    async stop() {
      calls.push(`stop:${name}`);
    },
    async health() {
      return {
        name,
        status: "running",
        enabled: true,
      };
    },
  };
}

describe("BackgroundWorker / WorkerRegistry", () => {
  it("starts in registration order and drains in reverse order", async () => {
    const calls: string[] = [];
    const registry = new WorkerRegistry({ drainTimeoutMs: 1000 });
    registry.registerAll([
      recordingWorker("a", calls),
      recordingWorker("b", calls),
      recordingWorker("c", calls),
    ]);

    await registry.startAll();
    assert.deepEqual(calls, ["start:a", "start:b", "start:c"]);

    const health = await registry.healthAll();
    assert.deepEqual(Object.keys(health), ["a", "b", "c"]);
    assert.equal(health.b.status, "running");

    await registry.stopAll();
    assert.deepEqual(calls, [
      "start:a",
      "start:b",
      "start:c",
      "stop:c",
      "stop:b",
      "stop:a",
    ]);
  });

  it("createWorker tracks state, skips disabled workers and is idempotent", async () => {
    let starts = 0;
    let stops = 0;
    const worker = createWorker({
      name: "loop",
      start: () => {
        starts += 1;
      },
      stop: () => {
        stops += 1;
      },
      health: () => ({ ticks: 7 }),
    });

    assert.equal((await worker.health()).status, "stopped");
    await worker.start();
    await worker.start(); // no-op
    assert.equal(starts, 1);
    const running = await worker.health();
    assert.equal(running.status, "running");
    assert.deepEqual(running.detail, { ticks: 7 });

    await worker.stop();
    await worker.stop(); // no-op
    assert.equal(stops, 1);
    assert.equal((await worker.health()).status, "stopped");

    const disabled = createWorker({
      name: "off",
      enabled: false,
      start: () => {
        throw new Error("must not start");
      },
      stop: () => undefined,
    });
    assert.equal((await disabled.health()).status, "disabled");
    await disabled.start();
    assert.equal((await disabled.health()).status, "disabled");
  });

  it("rolls back already-started workers when a start fails", async () => {
    const calls: string[] = [];
    const registry = new WorkerRegistry({ drainTimeoutMs: 1000 });
    registry.registerAll([
      recordingWorker("first", calls),
      {
        name: "broken",
        enabled: true,
        async start() {
          calls.push("start:broken");
          throw new Error("boom");
        },
        async stop() {
          calls.push("stop:broken");
        },
        async health() {
          return { name: "broken", status: "failed", enabled: true };
        },
      },
    ]);

    await assert.rejects(() => registry.startAll(), /boom/);
    assert.deepEqual(calls, ["start:first", "start:broken", "stop:first"]);
  });

  it("bounds a hung stop and still drains the remaining workers", async () => {
    const calls: string[] = [];
    const registry = new WorkerRegistry({ drainTimeoutMs: 20 });
    registry.register(recordingWorker("fast", calls));
    registry.register({
      name: "hung",
      enabled: true,
      async start() {},
      stop: () => new Promise<void>(() => undefined),
      async health() {
        return { name: "hung", status: "running", enabled: true };
      },
    });
    await registry.startAll();

    const error = await registry.stopAll().catch((err: unknown) => err);
    assert.ok(error instanceof AggregateError);
    assert.ok(
      error.errors.some((cause) => cause instanceof WorkerStopTimeoutError),
    );
    // "hung" is stopped first (reverse order), then "fast" still gets drained.
    assert.deepEqual(calls, ["start:fast", "stop:fast"]);
  });
});
