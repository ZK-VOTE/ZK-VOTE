/**
 * Transaction Confirmation Queue (#172)
 *
 * Replaces the per-request polling loop that `waitForTransaction` used to run.
 * Every confirmation wait is enqueued here and processed by a single dedicated
 * worker, which polls Soroban `getTransaction` with exponential backoff +
 * jitter. Benefits:
 *
 *  - Multiple concurrent waiters for the same hash share one poller (coalescing).
 *  - Poll cadence starts at ~2s (one Stellar ledger close) and backs off on
 *    congestion, so rapid confirmations are caught early without wasting RPC
 *    calls while the network is slow.
 *  - A hard wall-clock deadline (`maxWaitMs`) bounds every wait; transactions
 *    that never confirm are marked EXPIRED ("too late to confirm").
 *  - Resolved outcomes are cached briefly so the status endpoint and repeat
 *    callers see the result without re-polling.
 *  - Confirmation times and attempt counts feed Prometheus metrics, and every
 *    resolution is broadcast to connected frontends over WebSocket.
 *
 * Backward compatibility: `waitForTransaction(hash, maxAttempts)` still works;
 * a numeric second argument is treated as a cap on the number of polls.
 */

import type * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { log } from "./logger.js";
import { server } from "./stellar.js";
import { broadcastConfirmationEvent } from "./confirmation-hub.js";
import {
  txConfirmationsTotal,
  txConfirmationDuration,
  txConfirmationAttempts,
  txConfirmationQueueDepth,
  txConfirmationCacheSize,
  txConfirmationPollTotal,
} from "./metrics.js";

// ============================================
// TYPES
// ============================================

export type ConfirmationState =
  | "PENDING" // queued, worker still polling
  | "CONFIRMED" // resolved on-chain (SUCCESS or other terminal status)
  | "FAILED" // resolved with a non-SUCCESS, non-NOT_FOUND status
  | "EXPIRED" // never confirmed within the wait budget (too late to confirm)
  | "UNKNOWN"; // not queued/cached and a single lookup found nothing

export interface WaitForTransactionOptions {
  /** Hard wall-clock deadline for confirmation, in ms. */
  maxWaitMs?: number;
  /** Cap on the number of getTransaction polls (attempt 0 is the first). */
  maxAttempts?: number;
  /** Delay before the first retry after a NOT_FOUND, in ms. */
  initialDelayMs?: number;
  /** Upper bound on each per-poll backoff delay, in ms. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each NOT_FOUND. */
  backoffFactor?: number;
  /** Apply equal jitter to each delay (defaults to config). */
  jitter?: boolean;
  /** Called with each poll result, including intermediate NOT_FOUNDs. */
  onStatus?: (status: ConfirmationStatus) => void;
}

export interface ConfirmationStatus {
  hash: string;
  state: ConfirmationState;
  /** Raw Stellar `getTransaction` status (SUCCESS/FAILED/NOT_FOUND). */
  status?: string;
  attempts: number;
  elapsedMs: number;
  result?: StellarSdk.rpc.Api.GetTransactionResponse;
  error?: string;
  enqueuedAt?: string;
  confirmedAt?: string;
}

interface Waiter {
  resolve: (r: StellarSdk.rpc.Api.GetTransactionResponse) => void;
  reject: (e: Error) => void;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingEntry {
  hash: string;
  options: Required<
    Pick<
      WaitForTransactionOptions,
      | "maxWaitMs"
      | "maxAttempts"
      | "initialDelayMs"
      | "maxDelayMs"
      | "backoffFactor"
      | "jitter"
    >
  >;
  deadline: number;
  startTime: number;
  attempts: number;
  nextPollAt: number;
  pollInFlight: boolean;
  resolved: boolean;
  lastResult?: StellarSdk.rpc.Api.GetTransactionResponse;
  waiters: Waiter[];
}

interface CachedOutcome {
  state: Exclude<ConfirmationState, "PENDING" | "UNKNOWN">;
  result?: StellarSdk.rpc.Api.GetTransactionResponse;
  error?: string;
  resolvedAt: number;
  enqueuedAt: number;
  attempts: number;
}

// ============================================
// ERRORS
// ============================================

/**
 * Thrown when a transaction does not confirm within its wait budget.
 * `state` is always "EXPIRED": a NOT_FOUND that persists past the deadline is
 * treated as too late to confirm (the transaction is no longer in the ledger's
 * inclusion window and will never be found).
 */
export class TransactionConfirmationTimeoutError extends Error {
  readonly hash: string;
  readonly waitedMs: number;
  readonly attempts: number;
  readonly state: ConfirmationState = "EXPIRED";

  constructor(hash: string, waitedMs: number, attempts: number) {
    super(
      `Transaction not found after timeout (hash=${hash}, waitedMs=${waitedMs}, attempts=${attempts})`,
    );
    this.name = "TransactionConfirmationTimeoutError";
    this.hash = hash;
    this.waitedMs = waitedMs;
    this.attempts = attempts;
  }
}

// ============================================
// QUEUE STATE
// ============================================

const pending = new Map<string, PendingEntry>();
const resultsCache = new Map<string, CachedOutcome>();

let running = false;
let workerPromise: Promise<void> | null = null;
let wakeResolvers: Array<() => void> = [];

// ============================================
// BACKOFF CALCULATION
// ============================================

/**
 * Compute the delay before the next poll after `notFoundCount` consecutive
 * NOT_FOUND responses. Exponential growth capped at `maxDelayMs`, with equal
 * jitter (half-width around the base) to avoid thundering-herd re-polling.
 */
function computeBackoffDelay(
  notFoundCount: number,
  opts: PendingEntry["options"],
): number {
  const base = Math.min(
    opts.maxDelayMs,
    opts.initialDelayMs * Math.pow(opts.backoffFactor, Math.max(0, notFoundCount - 1)),
  );
  if (!opts.jitter) return base;
  // Equal jitter: [base * 0.5, base]
  const half = base * 0.5;
  return Math.floor(half + Math.random() * half);
}

function resolveOptions(
  o: WaitForTransactionOptions,
): PendingEntry["options"] {
  const maxAttempts = o.maxAttempts ?? 60;
  const initialDelayMs = o.initialDelayMs ?? config.confirmationInitialDelayMs;
  const maxDelayMs = o.maxDelayMs ?? config.confirmationMaxDelayMs;
  // A legacy numeric maxAttempts also bounds the wall-clock wait so callers
  // that relied on "attempts x 1s" don't suddenly wait far longer.
  const derivedWait = maxAttempts * initialDelayMs;
  const maxWaitMs = Math.min(
    o.maxWaitMs ?? config.confirmationMaxWaitMs,
    Number.isFinite(derivedWait) ? derivedWait : config.confirmationMaxWaitMs,
  );
  return {
    maxWaitMs: Math.max(0, maxWaitMs),
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffFactor: o.backoffFactor ?? config.confirmationBackoffFactor,
    jitter: o.jitter ?? config.confirmationJitterEnabled,
  };
}

// ============================================
// WORKER
// ============================================

function ensureWorkerRunning(): void {
  if (!running) startConfirmationWorker();
}

/** Resolve any in-flight sleep so the loop re-scans immediately. */
function wakeWorker(): void {
  const resolvers = wakeResolvers;
  wakeResolvers = [];
  for (const r of resolvers) r();
}

/** Sleep for `ms`, but wake early when a new hash is enqueued. */
function sleepWithWake(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const idx = wakeResolvers.indexOf(onWake);
      if (idx >= 0) wakeResolvers.splice(idx, 1);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    const onWake = () => finish();
    wakeResolvers.push(onWake);
  });
}

function earliestNextPoll(): number | null {
  let earliest: number | null = null;
  for (const entry of pending.values()) {
    if (entry.resolved || entry.pollInFlight) continue;
    if (earliest === null || entry.nextPollAt < earliest) {
      earliest = entry.nextPollAt;
    }
  }
  return earliest;
}

async function workerLoop(): Promise<void> {
  while (running) {
    const now = Date.now();
    let due: PendingEntry | null = null;
    for (const entry of pending.values()) {
      if (entry.resolved || entry.pollInFlight) continue;
      if (entry.nextPollAt <= now) {
        due = entry;
        break;
      }
    }

    if (due) {
      const waitMs = Math.max(0, due.nextPollAt - now);
      if (waitMs > 0) await sleepWithWake(waitMs);
      if (!running) break;
      const entry = pending.get(due.hash);
      if (
        entry &&
        entry === due &&
        !entry.resolved &&
        !entry.pollInFlight &&
        entry.nextPollAt <= Date.now()
      ) {
        await pollEntry(entry);
      }
      continue;
    }

    // Nothing due right now: idle until the earliest scheduled poll.
    const next = earliestNextPoll();
    const sleepMs =
      next === null
        ? Math.min(60_000, config.confirmationMaxWaitMs)
        : Math.min(60_000, Math.max(0, next - Date.now()));
    await sleepWithWake(sleepMs);
  }
}

async function pollEntry(entry: PendingEntry): Promise<void> {
  entry.pollInFlight = true;
  try {
    const result = await (
      server as StellarSdk.rpc.Server
    ).getTransaction(entry.hash);
    txConfirmationPollTotal.inc();
    entry.attempts++;
    entry.lastResult = result;

    if (result.status !== "NOT_FOUND") {
      const state = result.status === "SUCCESS" ? "CONFIRMED" : "FAILED";
      resolveEntry(entry, result, state);
      return;
    }

    // Still not found: is the wait budget exhausted?
    const timedOut =
      Date.now() >= entry.deadline || entry.attempts >= entry.options.maxAttempts;
    if (timedOut) {
      const err = new TransactionConfirmationTimeoutError(
        entry.hash,
        Date.now() - entry.startTime,
        entry.attempts,
      );
      failEntry(entry, err);
      return;
    }

    entry.nextPollAt = Date.now() + computeBackoffDelay(entry.attempts, entry.options);
  } catch (err) {
    // RPC error: transient. Do not count it as a poll; retry after backoff
    // unless the deadline has already passed.
    entry.nextPollAt = Date.now() + computeBackoffDelay(entry.attempts + 1, entry.options);
    if (Date.now() >= entry.deadline) {
      const timeoutErr = new TransactionConfirmationTimeoutError(
        entry.hash,
        Date.now() - entry.startTime,
        entry.attempts,
      );
      failEntry(entry, timeoutErr);
    }
  } finally {
    entry.pollInFlight = false;
  }
}

function resolveEntry(
  entry: PendingEntry,
  result: StellarSdk.rpc.Api.GetTransactionResponse,
  state: "CONFIRMED" | "FAILED",
): void {
  if (entry.resolved) return;
  entry.resolved = true;
  const elapsedMs = Date.now() - entry.startTime;

  txConfirmationsTotal.inc({ status: state });
  txConfirmationDuration.observe({ status: state }, elapsedMs / 1000);
  txConfirmationAttempts.observe({ status: state }, entry.attempts);

  resultsCache.set(entry.hash, {
    state,
    result,
    resolvedAt: Date.now(),
    enqueuedAt: entry.startTime,
    attempts: entry.attempts,
  });
  updateCacheMetric();

  for (const w of entry.waiters) {
    clearTimeout(w.timer);
    w.resolve(result);
  }
  entry.waiters = [];
  pending.delete(entry.hash);
  updateQueueDepthMetric();

  broadcastConfirmationEvent({
    type: "tx_confirmation",
    hash: entry.hash,
    state,
    status: result.status,
    attempts: entry.attempts,
    durationMs: elapsedMs,
    confirmedAt: new Date().toISOString(),
  });

  log("info", "tx_confirmation_resolved", {
    hash: entry.hash,
    state,
    status: result.status,
    attempts: entry.attempts,
    elapsedMs,
  });
}

function failEntry(
  entry: PendingEntry,
  error: TransactionConfirmationTimeoutError,
): void {
  if (entry.resolved) return;
  entry.resolved = true;
  const elapsedMs = Date.now() - entry.startTime;

  txConfirmationsTotal.inc({ status: "EXPIRED" });
  txConfirmationDuration.observe({ status: "EXPIRED" }, elapsedMs / 1000);
  txConfirmationAttempts.observe({ status: "EXPIRED" }, entry.attempts);

  resultsCache.set(entry.hash, {
    state: "EXPIRED",
    error: error.message,
    resolvedAt: Date.now(),
    enqueuedAt: entry.startTime,
    attempts: entry.attempts,
  });
  updateCacheMetric();

  for (const w of entry.waiters) {
    clearTimeout(w.timer);
    w.reject(error);
  }
  entry.waiters = [];
  pending.delete(entry.hash);
  updateQueueDepthMetric();

  broadcastConfirmationEvent({
    type: "tx_confirmation",
    hash: entry.hash,
    state: "EXPIRED",
    status: "NOT_FOUND",
    attempts: entry.attempts,
    durationMs: elapsedMs,
    confirmedAt: null,
    error: error.message,
  });

  log("info", "tx_confirmation_expired", {
    hash: entry.hash,
    attempts: entry.attempts,
    elapsedMs,
  });
}

function updateQueueDepthMetric(): void {
  txConfirmationQueueDepth.set(pending.size);
}

function updateCacheMetric(): void {
  txConfirmationCacheSize.set(resultsCache.size);
}

/** Drop cache entries older than the configured TTL. */
function pruneCache(): void {
  if (resultsCache.size === 0) return;
  const cutoff = Date.now() - config.confirmationResultCacheTtlMs;
  for (const [hash, outcome] of resultsCache) {
    if (outcome.resolvedAt < cutoff) resultsCache.delete(hash);
  }
  updateCacheMetric();
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Wait for a transaction to confirm.
 *
 * Enqueues the hash on the shared confirmation queue (coalescing concurrent
 * waiters) and resolves with the first non-NOT_FOUND `getTransaction` result,
 * or rejects with `TransactionConfirmationTimeoutError` if the transaction
 * never confirms within the wait budget.
 *
 * @param hash Stellar transaction hash
 * @param maxAttemptsOrOptions legacy numeric poll cap, or full options
 */
export async function waitForTransaction(
  hash: string,
  maxAttemptsOrOptions: number | WaitForTransactionOptions = {},
): Promise<StellarSdk.rpc.Api.GetTransactionResponse> {
  const options: WaitForTransactionOptions =
    typeof maxAttemptsOrOptions === "number"
      ? { maxAttempts: maxAttemptsOrOptions }
      : (maxAttemptsOrOptions ?? {});

  const opts = resolveOptions(options);

  if (opts.maxAttempts <= 0 || opts.maxWaitMs <= 0) {
    throw new TransactionConfirmationTimeoutError(hash, 0, 0);
  }

  // Fast path: an outcome was already resolved and is still cached.
  pruneCache();
  const cached = resultsCache.get(hash);
  if (cached) {
    if (cached.result) return cached.result;
    throw new TransactionConfirmationTimeoutError(
      hash,
      cached.resolvedAt - cached.enqueuedAt,
      cached.attempts,
    );
  }

  if (!config.confirmationQueueEnabled) {
    return pollDirectly(hash, opts);
  }

  return new Promise<StellarSdk.rpc.Api.GetTransactionResponse>(
    (resolve, reject) => {
      let entry = pending.get(hash);
      if (!entry) {
        entry = {
          hash,
          options: opts,
          deadline: Date.now() + opts.maxWaitMs,
          startTime: Date.now(),
          attempts: 0,
          nextPollAt: Date.now(),
          pollInFlight: false,
          resolved: false,
          waiters: [],
        };
        pending.set(hash, entry);
        updateQueueDepthMetric();
        ensureWorkerRunning();
        wakeWorker();
      }
      const waiter: Waiter = {
        resolve,
        reject,
        deadline: Date.now() + opts.maxWaitMs,
      };
      // Per-waiter deadline: a caller with a shorter budget than the shared
      // entry must not wait for the shared poller to give up.
      waiter.timer = setTimeout(() => {
        const idx = entry!.waiters.indexOf(waiter);
        if (idx >= 0) entry!.waiters.splice(idx, 1);
        reject(
          new TransactionConfirmationTimeoutError(
            hash,
            Date.now() - entry!.startTime,
            entry!.attempts,
          ),
        );
      }, opts.maxWaitMs);
      waiter.timer.unref?.();
      entry.waiters.push(waiter);
    },
  );
}

/**
 * Fallback used when the queue is disabled: a plain polling loop with the same
 * backoff policy, preserving `waitForTransaction`'s original behavior.
 */
async function pollDirectly(
  hash: string,
  opts: PendingEntry["options"],
): Promise<StellarSdk.rpc.Api.GetTransactionResponse> {
  const deadline = Date.now() + opts.maxWaitMs;
  let attempts = 0;
  while (Date.now() < deadline && attempts < opts.maxAttempts) {
    const result = await (
      server as StellarSdk.rpc.Server
    ).getTransaction(hash);
    txConfirmationPollTotal.inc();
    attempts++;
    if (result.status !== "NOT_FOUND") return result;
    if (attempts < opts.maxAttempts && Date.now() < deadline) {
      await new Promise((r) =>
        setTimeout(r, computeBackoffDelay(attempts, opts)),
      );
    }
  }
  throw new TransactionConfirmationTimeoutError(
    hash,
    Date.now() - (deadline - opts.maxWaitMs),
    attempts,
  );
}

/**
 * Resolve the current confirmation status of a hash without blocking.
 * Used by the `GET /tx/:hash` endpoint as a polling fallback for frontends
 * that cannot (or choose not to) use the WebSocket feed.
 */
export async function getConfirmationStatus(
  hash: string,
): Promise<ConfirmationStatus> {
  pruneCache();
  const cached = resultsCache.get(hash);
  if (cached) {
    return {
      hash,
      state: cached.state,
      status: cached.result?.status,
      attempts: cached.attempts,
      elapsedMs: cached.resolvedAt - cached.enqueuedAt,
      result: cached.result,
      error: cached.error,
      confirmedAt: new Date(cached.resolvedAt).toISOString(),
    };
  }

  const entry = pending.get(hash);
  if (entry && !entry.resolved) {
    return {
      hash,
      state: "PENDING",
      status: entry.lastResult?.status,
      attempts: entry.attempts,
      elapsedMs: Date.now() - entry.startTime,
      enqueuedAt: new Date(entry.startTime).toISOString(),
    };
  }

  // Not queued and not cached: do a single lookup so a frontend can discover
  // a transaction it missed (e.g. confirmed before the socket connected).
  try {
    const result = await (
      server as StellarSdk.rpc.Server
    ).getTransaction(hash);
    if (result.status !== "NOT_FOUND") {
      return {
        hash,
        state: result.status === "SUCCESS" ? "CONFIRMED" : "FAILED",
        status: result.status,
        attempts: 1,
        elapsedMs: 0,
        result,
        confirmedAt: new Date().toISOString(),
      };
    }
    return { hash, state: "UNKNOWN", status: "NOT_FOUND", attempts: 0, elapsedMs: 0 };
  } catch (err) {
    return {
      hash,
      state: "UNKNOWN",
      attempts: 0,
      elapsedMs: 0,
      error: (err as Error).message,
    };
  }
}

export function getConfirmationQueueStats(): {
  running: boolean;
  pending: number;
  cached: number;
} {
  return {
    running,
    pending: pending.size,
    cached: resultsCache.size,
  };
}

/**
 * Start the dedicated confirmation worker. Idempotent. Also started lazily on
 * the first enqueue so tests and early callers don't need explicit setup.
 */
export function startConfirmationWorker(): void {
  if (running) return;
  running = true;
  workerPromise = workerLoop();
  log("info", "confirmation_worker_started", { pending: pending.size });
}

/**
 * Stop the worker and reject any still-pending waiters so callers never hang
 * on shutdown. Idempotent.
 */
export async function stopConfirmationWorker(): Promise<void> {
  if (!running) return;
  running = false;
  wakeWorker();
  await workerPromise?.catch(() => {});
  workerPromise = null;
  for (const entry of pending.values()) {
    if (!entry.resolved) {
      failEntry(
        entry,
        new TransactionConfirmationTimeoutError(
          entry.hash,
          Date.now() - entry.startTime,
          entry.attempts,
        ),
      );
    }
  }
  log("info", "confirmation_worker_stopped", { pending: pending.size });
}
