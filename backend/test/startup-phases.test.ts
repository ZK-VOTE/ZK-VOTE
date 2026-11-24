/**
 * Startup phase ordering / fail-closed tests for `src/startup-phases.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  StartupPhaseError,
  STARTUP_PHASES,
  createStartupPhases,
} from "../src/startup-phases.js";

describe("StartupPhases", () => {
  it("walks the full ordered sequence and records timings", async () => {
    const phases = createStartupPhases();
    assert.deepEqual([...STARTUP_PHASES], [
      "config",
      "infrastructure",
      "services",
      "routes",
      "workers",
      "ready",
    ]);

    await phases.run("config", () => "ok");
    phases.checkpoint("infrastructure");
    await phases.run("services", () => 42);
    phases.checkpoint("routes");
    phases.checkpoint("workers");
    await phases.run("ready", () => true);

    assert.equal(phases.isReady, true);
    assert.equal(phases.failed, null);
    assert.deepEqual(
      phases.timings.map((timing) => timing.phase),
      [...STARTUP_PHASES],
    );
    assert.ok(
      phases.timings.every(
        (timing) => timing.status === "ok" && timing.durationMs >= 0,
      ),
    );
    assert.ok(phases.report().totalDurationMs >= 0);
  });

  it("refuses to advance past a failed phase", async () => {
    const phases = createStartupPhases();
    const failure = new Error("missing critical config");

    await assert.rejects(
      () =>
        phases.run("config", () => {
          throw failure;
        }),
      /missing critical config/,
    );

    assert.equal(phases.failed, "config");
    assert.equal(phases.timings.length, 1);
    assert.equal(phases.timings[0].status, "failed");
    assert.equal(phases.isReady, false);

    await assert.rejects(
      () => phases.run("infrastructure", () => undefined),
      /already failed at phase "config"/,
    );
    assert.throws(
      () => phases.checkpoint("services"),
      (error: unknown) => error instanceof StartupPhaseError,
    );
    assert.equal(phases.timings.length, 1, "no further phase may be recorded");
  });

  it("rejects out-of-order phases before executing them", async () => {
    const phases = createStartupPhases();
    let ran = false;

    await phases.run("config", () => undefined);
    assert.throws(
      () => phases.checkpoint("workers"),
      /Expected startup phase "infrastructure" but got "workers"/,
    );
    await assert.rejects(
      () =>
        phases.run("services", () => {
          ran = true;
        }),
      /Expected startup phase "infrastructure" but got "services"/,
    );
    assert.equal(ran, false);
  });
});
