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
