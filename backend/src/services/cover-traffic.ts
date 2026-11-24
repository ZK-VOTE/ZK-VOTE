/**
 * Cover-traffic scheduler (SPIKE-025 / #710).
 *
 * Fires `onTick` as a Poisson process: inter-arrival times are exponentially
 * distributed with mean `meanIntervalMs`, so an observer cannot read the
 * schedule off a fixed polling grid. Randomness comes from the OS CSPRNG, not
 * Math.random. `start()` is idempotent and `stop()` cancels the pending timer,
 * so the scheduler can be shut down cleanly (the previous setInterval was
 * never cleared).
 *
 * This only decides *when* a dummy would be sent. It does not send anything:
 * who pays the Soroban fees for dummies is an open question (see
 * docs/spikes/SPIKE-025-rate-limit-cover-traffic.md).
 */

import crypto from "node:crypto";

export interface CoverTrafficOptions {
  meanIntervalMs: number;
  onTick: () => void;
  onError?: (err: unknown) => void;
  /** Uniform sample in [0, 1). Defaults to a CSPRNG-backed source. */
  random?: () => number;
}

/** Uniform sample in [0, 1) from 48 CSPRNG bits. */
export function secureRandom(): number {
  return crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/** Exponential inter-arrival time, in whole ms (at least 1). */
export function nextDelayMs(meanIntervalMs: number, u: number): number {
  return Math.max(1, Math.round(-Math.log(1 - u) * meanIntervalMs));
}

export function createCoverTrafficScheduler(opts: CoverTrafficOptions) {
  if (!(opts.meanIntervalMs > 0)) {
    throw new RangeError("meanIntervalMs must be positive");
  }
  const random = opts.random ?? secureRandom;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const arm = (): void => {
    timer = setTimeout(() => {
      if (!running) return;
      try {
        opts.onTick();
      } catch (err) {
        // A throw inside a timer is an uncaught exception; report it instead.
        opts.onError?.(err);
      }
      if (running) arm();
    }, nextDelayMs(opts.meanIntervalMs, random()));
    timer.unref?.();
  };

  return {
    start(): boolean {
      if (running) return false;
      running = true;
      arm();
      return true;
    },
    stop(): void {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get running(): boolean {
      return running;
    },
  };
}
