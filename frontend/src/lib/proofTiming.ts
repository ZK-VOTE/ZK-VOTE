/**
 * Timing side-channel mitigations for in-browser proof generation (#92).
 *
 * snarkjs proves with JavaScript BigInt arithmetic, which is not constant
 * time: scalar multiplication cost tracks the scalar's bit pattern and the
 * FFT's cost depends on its inputs. The witness contains the voter's identity
 * secret and their candidate choice, so *how long a proof takes* is correlated
 * with what is being proved. Anything that can observe that duration — a
 * co-resident script, an extension, or the page's own progress callbacks —
 * learns something about a private input.
 *
 * Making snarkjs constant time is not on the table; it would mean replacing
 * its field arithmetic. What is achievable is to stop the *observable*
 * duration from carrying the signal, which is what this module does:
 *
 *   - quantise the elapsed time up to a fixed grid, so durations that differ
 *     by less than the grid are indistinguishable from outside, and
 *   - add randomised delay on top, so the quantised value cannot be driven
 *     back down to the true cost by averaging repeated observations.
 *
 * Quantisation alone leaks across many samples (the boundary an input sits
 * near is itself information); jitter alone is removable by averaging. Doing
 * both means an observer must beat the grid *and* the noise.
 *
 * This bounds what an observer of wall-clock duration learns. It does not
 * address power, cache or branch-level side channels.
 */

/** Width of the quantisation grid, in milliseconds. */
export const TIMING_QUANTUM_MS = 250;

/** Maximum extra delay added on top of the quantised duration. */
export const MAX_JITTER_MS = 150;

/**
 * Timing budgets per device class and circuit depth.
 * PLACEHOLDER: These values need validation through measurement (SPIKE-029).
 *
 * #714 - Measured duration distributions required for:
 * - Choice indistinguishability (AUC ~0.5)
 * - Depth-variant timing
 * - Device class segmentation
 */
export const TIMING_BUDGETS_MS = {
  /** Desktop/laptop (high-end CPU) */
  desktop: {
    depth10: 1500,
    depth15: 2500,
    depth20: 4000,
    claim: 800,
  },
  /** Mobile (mid-range) */
  mobile: {
    depth10: 3000,
    depth15: 5000,
    depth20: 8000,
    claim: 1500,
  },
  /** Low-end mobile */
  lowEnd: {
    depth10: 5000,
    depth15: 9000,
    depth20: 15000,
    claim: 2500,
  },
} as const;

/**
 * Device class detection for timing budgets.
 * Simple heuristic; real implementation needs telemetry.
 */
export function detectDeviceClass(): keyof typeof TIMING_BUDGETS_MS {
  // Placeholder heuristic - real detection needs measurement
  if (typeof navigator === "undefined") return "desktop";

  const ua = navigator.userAgent.toLowerCase();
  const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua);

  // Rough RAM proxy (navigator.deviceMemory requires COOP/COEP)
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;

  if (isMobile) {
    if (memory !== undefined && memory < 4) return "lowEnd";
    return "mobile";
  }

  return "desktop";
}

/**
 * Random jitter in [0, MAX_JITTER_MS).
 *
 * Uses `crypto.getRandomValues` rather than `Math.random`: `Math.random` is
 * seeded per-context and its sequence can be predicted from prior outputs, so
 * an observer able to sample it could subtract the noise it contributes.
 */
export function jitterMs(random: Pick<Crypto, "getRandomValues"> = crypto): number {
  const buf = new Uint32Array(1);
  random.getRandomValues(buf);
  return (buf[0] / 2 ** 32) * MAX_JITTER_MS;
}

/**
 * The next multiple of {@link TIMING_QUANTUM_MS} at or above `elapsed`.
 *
 * An exact multiple is pushed up to the next step rather than returned as-is:
 * otherwise a proof landing exactly on a boundary would be revealed by
 * completing with no padding at all.
 */
export function quantiseMs(elapsed: number, quantum = TIMING_QUANTUM_MS): number {
  if (!Number.isFinite(elapsed) || elapsed < 0) return quantum;
  return (Math.floor(elapsed / quantum) + 1) * quantum;
}

/**
 * How long to wait after `elapsed` so the total is a quantised, jittered
 * duration. Never negative, so a proof slower than the grid is not rushed.
 */
export function paddingMs(elapsed: number, jitter: number): number {
  return Math.max(0, quantiseMs(elapsed) + jitter - elapsed);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `work` and resolves only once a quantised, jittered interval has
 * passed, so the caller cannot time the underlying computation.
 *
 * The result is held until the padding elapses — resolving early and padding
 * afterwards would defeat the point, since the caller observes resolution.
 * A throw is padded too: failing fast on a malformed witness would otherwise
 * be distinguishable from a completed proof.
 */
export async function withMaskedTiming<T>(
  work: () => Promise<T>,
  now: () => number = () => performance.now(),
): Promise<T> {
  const started = now();
  const jitter = jitterMs();
  try {
    const result = await work();
    await sleep(paddingMs(now() - started, jitter));
    return result;
  } catch (err) {
    await sleep(paddingMs(now() - started, jitter));
    throw err;
  }
}

/**
 * Whether the page is cross-origin isolated.
 *
 * Without isolation the browser degrades `performance.now()` and denies
 * `SharedArrayBuffer`, which blunts cross-origin timing attacks but also means
 * proving runs without the guarantees COOP/COEP provide. Surfaced so the app
 * can warn rather than silently prove in a weaker environment.
 */
export function isCrossOriginIsolated(): boolean {
  return typeof globalThis.crossOriginIsolated === "boolean"
    ? globalThis.crossOriginIsolated
    : false;
}

/**
 * Timing measurement for distinguishability analysis (#714).
 *
 * Collects duration samples to validate masking effectiveness.
 * NOT for production telemetry - measurement mode only.
 */
export interface TimingSample {
  /** Circuit type: 'vote' | 'claim' */
  circuitType: string;
  /** Merkle tree depth */
  depth?: number;
  /** Raw elapsed time (ms) before masking */
  rawDuration: number;
  /** Masked duration (ms) after quantization + jitter */
  maskedDuration: number;
  /** Device class */
  deviceClass: string;
  /** Timestamp */
  timestamp: number;
}

let timingSamples: TimingSample[] = [];
let measurementMode = false;

/**
 * Enable timing measurement mode (dev/test only).
 * Collects samples for statistical analysis.
 */
export function enableTimingMeasurement(): void {
  measurementMode = true;
  timingSamples = [];
}

/**
 * Disable timing measurement and clear samples.
 */
export function disableTimingMeasurement(): void {
  measurementMode = false;
  timingSamples = [];
}

/**
 * Get collected timing samples (measurement mode only).
 */
export function getTimingSamples(): readonly TimingSample[] {
  return [...timingSamples];
}

/**
 * Record a timing sample (if measurement mode enabled).
 *
 * @param sample Timing measurement to record
 * @internal
 */
function recordTimingSample(sample: TimingSample): void {
  if (measurementMode) {
    timingSamples.push(sample);
  }
}

/**
 * Enhanced timing mask with measurement support.
 *
 * Wrapper around withMaskedTiming that optionally records samples
 * for statistical validation.
 */
export async function withMaskedTimingAndMeasurement<T>(
  work: () => Promise<T>,
  context: {
    circuitType: string;
    depth?: number;
  },
  now: () => number = () => performance.now(),
): Promise<T> {
  const started = now();
  const deviceClass = detectDeviceClass();

  try {
    const result = await withMaskedTiming(work, now);
    const elapsed = now() - started;

    recordTimingSample({
      circuitType: context.circuitType,
      depth: context.depth,
      rawDuration: elapsed - paddingMs(elapsed, jitterMs()),
      maskedDuration: elapsed,
      deviceClass,
      timestamp: Date.now(),
    });

    return result;
  } catch (err) {
    const elapsed = now() - started;

    recordTimingSample({
      circuitType: context.circuitType,
      depth: context.depth,
      rawDuration: elapsed - paddingMs(elapsed, jitterMs()),
      maskedDuration: elapsed,
      deviceClass,
      timestamp: Date.now(),
    });

    throw err;
  }
}

/**
 * Statistical summary of timing samples.
 * Placeholder for full analysis (SPIKE-029 acceptance criteria).
 */
export interface TimingStatistics {
  count: number;
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  p95: number;
  p99: number;
}

/**
 * Compute basic statistics from timing samples.
 * Real implementation needs proper quantile estimation.
 */
export function computeTimingStatistics(
  samples: readonly TimingSample[],
  filter: (s: TimingSample) => boolean = () => true,
): TimingStatistics | null {
  const filtered = samples.filter(filter);
  if (filtered.length === 0) return null;

  const durations = filtered.map((s) => s.rawDuration).sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);
  const mean = sum / durations.length;

  const variance = durations.reduce((acc, d) => acc + (d - mean) ** 2, 0) / durations.length;
  const stdDev = Math.sqrt(variance);

  const median = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const p99 = durations[Math.floor(durations.length * 0.99)];

  return {
    count: durations.length,
    mean,
    median,
    stdDev,
    min: durations[0],
    max: durations[durations.length - 1],
    p95,
    p99,
  };
}
