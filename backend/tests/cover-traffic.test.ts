/**
 * SPIKE-025 (#710): cover-traffic scheduler. Runs under the backend's
 * node:test runner (tsx).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCoverTrafficScheduler,
  nextDelayMs,
  secureRandom,
} from "../src/services/cover-traffic.js";

describe("nextDelayMs", () => {
  it("is exponential: the median is mean * ln 2", () => {
    assert.equal(nextDelayMs(1000, 0.5), Math.round(1000 * Math.LN2));
  });

  it("never returns less than 1ms, even for u = 0", () => {
    assert.equal(nextDelayMs(1000, 0), 1);
  });

  it("has a sample mean close to meanIntervalMs", () => {
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sum += nextDelayMs(1000, secureRandom());
    const mean = sum / n;
    assert.ok(mean > 950 && mean < 1050, `sample mean ${mean}`);
  });
});

describe("secureRandom", () => {
  it("stays in [0, 1) and is not constant", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const u = secureRandom();
      assert.ok(u >= 0 && u < 1);
      seen.add(u);
    }
    assert.ok(seen.size > 990);
  });
});

describe("createCoverTrafficScheduler", () => {
  it("rejects a non-positive mean", () => {
    assert.throws(
      () => createCoverTrafficScheduler({ meanIntervalMs: 0, onTick() {} }),
      RangeError,
    );
  });

  it("start is idempotent: a second start does not add a second timer", async () => {
    let ticks = 0;
    const s = createCoverTrafficScheduler({
      meanIntervalMs: 5,
      random: () => 0, // 1ms delay each time
      onTick: () => void ticks++,
    });
    assert.equal(s.start(), true);
    assert.equal(s.start(), false);
    await new Promise((r) => setTimeout(r, 60));
    s.stop();
    const at = ticks;
    assert.ok(at > 0);
    // One timer chain at ~1ms spacing cannot exceed ~60 ticks; two would double it.
    assert.ok(at <= 70, `ticks ${at}`);
  });

  it("stop halts ticking and allows a restart", async () => {
    let ticks = 0;
    const s = createCoverTrafficScheduler({
      meanIntervalMs: 5,
      random: () => 0,
      onTick: () => void ticks++,
    });
    s.start();
    await new Promise((r) => setTimeout(r, 30));
    s.stop();
    assert.equal(s.running, false);
    const frozen = ticks;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ticks, frozen);
    assert.equal(s.start(), true);
    s.stop();
  });

  it("reports a throwing tick and keeps scheduling", async () => {
    let ticks = 0;
    let errors = 0;
    const s = createCoverTrafficScheduler({
      meanIntervalMs: 5,
      random: () => 0,
      onTick: () => {
        ticks++;
        throw new Error("boom");
      },
      onError: () => void errors++,
    });
    s.start();
    await new Promise((r) => setTimeout(r, 30));
    s.stop();
    assert.ok(ticks >= 2);
    assert.equal(errors, ticks);
  });
});
