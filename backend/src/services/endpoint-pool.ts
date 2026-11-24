/**
 * Endpoint Pool — shared multi-endpoint routing for external dependencies (#745)
 *
 * Every money path used to hang off a single URL (HORIZON_URL, one anchor per
 * asset) and each service carried its own ad-hoc retry loop. This module is
 * the one policy all of them share:
 *
 *  - Health-weighted routing: endpoints are scored on an EWMA of latency and
 *    error rate; each has its own circuit breaker so one dead endpoint fails
 *    fast without dragging the dependency down.
 *  - Fallback matrix: what may fail over, what must be fresh, and what may be
 *    retried after an ambiguous failure is decided per operation class, not
 *    per call site (see FALLBACK_MATRIX).
 *  - Retry discipline: capped exponential backoff with jitter, Retry-After is
 *    honoured and puts the endpoint in cooldown for every caller, and a
 *    per-dependency retry budget caps retries at a fraction of real traffic so
 *    a 429 storm cannot be amplified into a retry storm.
 *  - Stale-read bound: ledger-aware pools probe each endpoint's latest ledger;
 *    reads that feed witnesses, sequence numbers or quotes are only served by
 *    endpoints within `maxLagLedgers` of the pool's tip.
 *  - Disagreement arbitration: `arbitratedRead` asks several fresh endpoints
 *    and applies the rules in `arbitrate` — highest ledger wins, same-ledger
 *    disagreement fails closed.
 */

import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  registerCircuitBreaker,
} from "./circuit-breaker.js";
import { log } from "./logger.js";
import {
  dependencyAvailableEndpoints,
  dependencyTotalEndpoints,
  endpointDisagreementTotal,
  endpointFailoverLatency,
  endpointFailoverTotal,
  endpointHealthy,
  endpointLatencySeconds,
  endpointLedgerLag,
  endpointRequestsTotal,
  endpointRetriesTotal,
  endpointRetryBudgetExhaustedTotal,
  endpointStaleRejectedTotal,
} from "./metrics.js";
import {
  markDegraded,
  markHealthy,
  markUnavailable,
  type ServiceName,
} from "./service-health.js";

// ============================================
// FALLBACK MATRIX
// ============================================

export type OperationClass =
  | "read"
  | "consistent_read"
  | "quote"
  | "submit_idempotent"
  | "submit_non_idempotent";

export interface FallbackRule {
  /** The call may move to another endpoint after a failure. */
  failover: boolean;
  /** The serving endpoint must be within the finality-lag bound. */
  requireFresh: boolean;
  /**
   * The call may be retried after a failure where the request may already
   * have been processed (timeout, connection reset, 500/504).
   */
  retryAmbiguous: boolean;
}

export const FALLBACK_MATRIX: Readonly<Record<OperationClass, FallbackRule>> =
  Object.freeze({
    // Display / preflight lookups (trustlines, balances). Any reachable
    // endpoint will do; a slightly stale answer is re-checked on submit.
    read: { failover: true, requireFresh: false, retryAmbiguous: true },
    // State that becomes part of something signed or proven: Merkle roots for
    // witnesses, account sequence numbers for transaction building.
    consistent_read: {
      failover: true,
      requireFresh: true,
      retryAmbiguous: true,
    },
    // Prices: a stale order book produces a wrong destMin.
    quote: { failover: true, requireFresh: true, retryAmbiguous: true },
    // A signed Stellar envelope is idempotent by hash (one sequence number,
    // applied at most once), so the SAME envelope may be resubmitted to any
    // endpoint. Callers must never rebuild or re-sign inside the retry.
    submit_idempotent: {
      failover: true,
      requireFresh: false,
      retryAmbiguous: true,
    },
    // Anchor POSTs and other requests where a duplicate creates a second
    // transfer. Only retried when the request provably never reached the
    // server (connection refused, 429, 502/503), and never moved elsewhere.
    submit_non_idempotent: {
      failover: false,
      requireFresh: false,
      retryAmbiguous: false,
    },
  });

// ============================================
// ERRORS & CLASSIFICATION
// ============================================

/** HTTP failure from a fetch-based client, carrying what the policy needs. */
export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export class EndpointTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`Timeout: ${label} (${timeoutMs}ms)`);
    this.name = "EndpointTimeoutError";
  }
}

export class DependencyUnavailableError extends Error {
  /** Preserved so existing handlers that read `e.response` keep working. */
  public readonly response?: unknown;

  constructor(
    public readonly dependency: string,
    public readonly opClass: OperationClass,
    public readonly lastError: unknown,
  ) {
    super(
      `${dependency} unavailable for ${opClass}: ${
        lastError instanceof Error ? lastError.message : "no eligible endpoint"
      }`,
    );
    this.name = "DependencyUnavailableError";
    this.response = (lastError as any)?.response;
  }
}

export class StaleReadError extends Error {
  constructor(
    public readonly dependency: string,
    public readonly opClass: OperationClass,
    maxLagLedgers: number,
  ) {
    super(
      `${dependency}: no endpoint within ${maxLagLedgers} ledgers of the chain tip for ${opClass}`,
    );
    this.name = "StaleReadError";
  }
}

export class EndpointDisagreementError extends Error {
  constructor(
    public readonly dependency: string,
    public readonly ledger: number,
    public readonly endpoints: string[],
  ) {
    super(
      `${dependency}: endpoints disagree at ledger ${ledger} (${endpoints.join(", ")})`,
    );
    this.name = "EndpointDisagreementError";
  }
}

export type FailureKind = "client" | "rate_limited" | "unavailable" | "ambiguous";

export interface ClassifiedFailure {
  kind: FailureKind;
  status?: number;
  retryAfterMs?: number;
}

/** Errors where the request never left this process or never reached the server. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function parseRetryAfterMs(
  value: unknown,
  now: number = Date.now(),
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function headerValue(headers: unknown, name: string): unknown {
  if (!headers) return undefined;
  if (typeof (headers as any).get === "function") {
    return (headers as any).get(name);
  }
  return (headers as any)[name] ?? (headers as any)[name.toLowerCase()];
}

export function classifyError(err: unknown): ClassifiedFailure {
  if (err instanceof CircuitBreakerOpenError) return { kind: "unavailable" };
  if (err instanceof EndpointTimeoutError) return { kind: "ambiguous" };

  const e = err as any;
  const status: unknown = e?.status ?? e?.response?.status;
  if (typeof status === "number") {
    if (status === 429) {
      return {
        kind: "rate_limited",
        status,
        retryAfterMs:
          e?.retryAfterMs ??
          parseRetryAfterMs(headerValue(e?.response?.headers, "retry-after")),
      };
    }
    // 502/503: the proxy or server refused before doing work.
    if (status === 502 || status === 503) return { kind: "unavailable", status };
    // 500/504/408: the work may have happened (Horizon returns 504 while a
    // submitted transaction is still pending).
    if (status >= 500 || status === 408) return { kind: "ambiguous", status };
    return { kind: "client", status };
  }

  const code: unknown = e?.code ?? e?.cause?.code;
  if (typeof code === "string" && NOT_SENT_CODES.has(code)) {
    return { kind: "unavailable" };
  }
  return { kind: "ambiguous" };
}

// ============================================
// RETRY POLICY & BUDGET
// ============================================

export interface RetryPolicy {
  /** Total attempts per call, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Retries allowed as a fraction of first attempts within the window. */
  budgetRatio: number;
  /** Retries always allowed per window, so low traffic can still recover. */
  budgetMinRetries: number;
  budgetWindowMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  budgetRatio: 0.2,
  budgetMinRetries: 10,
  budgetWindowMs: 10_000,
};

/**
 * Exponential backoff with equal jitter. A server-supplied Retry-After is a
 * floor, never shortened by jitter.
 */
export function computeBackoffMs(
  attempt: number,
  policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const delay = Math.floor(cap / 2 + random() * (cap / 2));
  return retryAfterMs !== undefined ? Math.max(retryAfterMs, delay) : delay;
}

/**
 * Sliding-window retry budget: retries may not exceed
 * max(budgetMinRetries, budgetRatio * requests) within the window. Under a
 * dependency-wide outage this caps load at roughly (1 + ratio)x normal.
 */
export class RetryBudget {
  private requests: number[] = [];
  private retries: number[] = [];

  constructor(
    private readonly policy: Pick<
      RetryPolicy,
      "budgetRatio" | "budgetMinRetries" | "budgetWindowMs"
    >,
    private readonly now: () => number = Date.now,
  ) {}

  recordRequest(): void {
    this.prune();
    this.requests.push(this.now());
  }

  tryAcquire(): boolean {
    this.prune();
    const allowed = Math.max(
      this.policy.budgetMinRetries,
      Math.floor(this.requests.length * this.policy.budgetRatio),
    );
    if (this.retries.length >= allowed) return false;
    this.retries.push(this.now());
    return true;
  }

  private prune(): void {
    const cutoff = this.now() - this.policy.budgetWindowMs;
    while (this.requests.length && this.requests[0] < cutoff) this.requests.shift();
    while (this.retries.length && this.retries[0] < cutoff) this.retries.shift();
  }
}

// ============================================
// DISAGREEMENT ARBITRATION
// ============================================

export interface LedgerStamped<V> {
  value: V;
  /** Ledger the endpoint's answer reflects (e.g. simulate's latestLedger). */
  ledger: number;
}

export interface ArbitrationInput<V> extends LedgerStamped<V> {
  endpoint: string;
}

export interface ArbitrationResult<V> {
  value: V;
  ledger: number;
  endpoint: string;
  /** Endpoints whose value matches the winner. */
  agreeing: string[];
  /** Fresh endpoints at an older ledger whose value has since changed. */
  superseded: string[];
  /** Endpoints further than maxLagLedgers behind the winner. */
  droppedStale: string[];
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Arbitration rules for endpoints that disagree:
 *
 *  1. Responses more than `maxLagLedgers` behind the highest ledger are stale
 *     and ignored.
 *  2. Ledger state only moves forward, so the answer at the highest ledger
 *     wins; a different value at an older ledger is superseded, not a dispute.
 *  3. Two endpoints claiming the same ledger with different values is a real
 *     consistency fault (fork, bug, or a lying endpoint): fail closed with
 *     EndpointDisagreementError rather than pick one.
 */
export function arbitrate<V>(
  responses: ArbitrationInput<V>[],
  maxLagLedgers: number,
  equals: (a: V, b: V) => boolean = jsonEquals,
  dependency = "unknown",
): ArbitrationResult<V> {
  if (responses.length === 0) {
    throw new Error(`${dependency}: no responses to arbitrate`);
  }
  const top = Math.max(...responses.map((r) => r.ledger));
  const fresh = responses.filter((r) => top - r.ledger <= maxLagLedgers);
  const droppedStale = responses
    .filter((r) => top - r.ledger > maxLagLedgers)
    .map((r) => r.endpoint);

  const atTop = fresh.filter((r) => r.ledger === top);
  const winner = atTop[0];
  if (atTop.some((r) => !equals(r.value, winner.value))) {
    throw new EndpointDisagreementError(
      dependency,
      top,
      atTop.map((r) => r.endpoint),
    );
  }

  return {
    value: winner.value,
    ledger: top,
    endpoint: winner.endpoint,
    agreeing: fresh.filter((r) => equals(r.value, winner.value)).map((r) => r.endpoint),
    superseded: fresh
      .filter((r) => !equals(r.value, winner.value))
      .map((r) => r.endpoint),
    droppedStale,
  };
}

// ============================================
// ENDPOINT POOL
// ============================================

export interface ProbeResult {
  /** Latest ledger the endpoint serves. Omit for non-ledger services. */
  ledger?: number;
  /** Ledgers the endpoint's own ingestion trails its core (Horizon). */
  ingestLagLedgers?: number;
}

export interface EndpointPoolOptions<C> {
  dependency: string;
  urls: string[];
  clientFactory: (url: string) => C;
  probe?: (client: C, url: string) => Promise<ProbeResult>;
  /**
   * Whether the probe reports ledgers, so freshness can be enforced.
   * Defaults to true when a probe is given; anchors probe without ledgers.
   */
  ledgerAware?: boolean;
  serviceName?: ServiceName;
  maxLagLedgers?: number;
  /** A ledger observation older than this does not count as fresh. */
  maxObservationAgeMs?: number;
  requestTimeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  breaker?: { failureThreshold?: number; resetTimeoutMs?: number };
  arbitrationQuorum?: number;
  /** Register with the global pool list (health monitor, /health). */
  register?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface EndpointStatus {
  /** URL origin only; full URLs may embed API keys. */
  endpoint: string;
  eligible: boolean;
  fresh: boolean;
  probeHealthy: boolean;
  breakerState: string;
  latencyEwmaMs: number;
  errorRateEwma: number;
  ledger: number | null;
  lagLedgers: number | null;
  cooldownRemainingMs: number;
}

export interface PoolStatus {
  dependency: string;
  totalEndpoints: number;
  availableEndpoints: number;
  freshEndpoints: number;
  tipLedger: number | null;
  maxLagLedgers: number;
  endpoints: EndpointStatus[];
}

interface EndpointState<C> {
  url: string;
  label: string;
  client: C;
  breaker: CircuitBreaker;
  probeHealthy: boolean;
  latencyEwmaMs: number;
  errorEwma: number;
  ledger: number | null;
  ledgerObservedAt: number;
  ingestLagLedgers: number;
  cooldownUntil: number;
}

const EWMA_ALPHA = 0.3;

/** Origin only — paths and queries may carry API keys. */
export function endpointLabel(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid-url";
  }
}

/** Shared policy knobs from config, so every pool retries the same way. */
export function poolOptionsFromConfig(cfg: {
  endpointMaxFinalityLagLedgers: number;
  endpointRequestTimeoutMs: number;
  endpointRetryMaxAttempts: number;
  endpointRetryBaseMs: number;
  endpointRetryMaxMs: number;
  endpointRetryBudgetRatio: number;
  endpointArbitrationQuorum: number;
  endpointHealthIntervalMs: number;
}): Pick<
  EndpointPoolOptions<unknown>,
  | "maxLagLedgers"
  | "maxObservationAgeMs"
  | "requestTimeoutMs"
  | "retry"
  | "arbitrationQuorum"
> {
  return {
    maxLagLedgers: cfg.endpointMaxFinalityLagLedgers,
    // Two missed probe rounds and an endpoint's ledger no longer counts.
    maxObservationAgeMs: cfg.endpointHealthIntervalMs * 2,
    requestTimeoutMs: cfg.endpointRequestTimeoutMs,
    retry: {
      maxAttempts: cfg.endpointRetryMaxAttempts,
      baseDelayMs: cfg.endpointRetryBaseMs,
      maxDelayMs: cfg.endpointRetryMaxMs,
      budgetRatio: cfg.endpointRetryBudgetRatio,
    },
    arbitrationQuorum: cfg.endpointArbitrationQuorum,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EndpointTimeoutError(label, timeoutMs)),
      timeoutMs,
    );
    (timer as any).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class EndpointPool<C> {
  readonly dependency: string;
  readonly maxLagLedgers: number;
  /** Whether endpoints report ledgers (and so freshness can be enforced). */
  readonly ledgerAware: boolean;
  private readonly endpoints: EndpointState<C>[];
  private readonly probe?: EndpointPoolOptions<C>["probe"];
  private readonly serviceName?: ServiceName;
  private readonly maxObservationAgeMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly budget: RetryBudget;
  private readonly arbitrationQuorum: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private refreshing: Promise<PoolStatus> | null = null;

  constructor(options: EndpointPoolOptions<C>) {
    const urls = Array.from(new Set(options.urls.filter(Boolean)));
    if (urls.length === 0) {
      throw new Error(`${options.dependency}: endpoint pool needs at least one URL`);
    }
    this.dependency = options.dependency;
    this.probe = options.probe;
    this.ledgerAware = options.ledgerAware ?? options.probe !== undefined;
    this.serviceName = options.serviceName;
    this.maxLagLedgers = options.maxLagLedgers ?? 5;
    this.maxObservationAgeMs = options.maxObservationAgeMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.arbitrationQuorum = options.arbitrationQuorum ?? 2;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.budget = new RetryBudget(this.retry, this.now);

    this.endpoints = urls.map((url) => {
      const label = endpointLabel(url);
      return {
        url,
        label,
        client: options.clientFactory(url),
        breaker: registerCircuitBreaker(`${this.dependency}:${label}`, {
          failureThreshold: options.breaker?.failureThreshold ?? 5,
          resetTimeoutMs: options.breaker?.resetTimeoutMs ?? 30_000,
        }),
        probeHealthy: true,
        latencyEwmaMs: 0,
        errorEwma: 0,
        ledger: null,
        ledgerObservedAt: 0,
        ingestLagLedgers: 0,
        cooldownUntil: 0,
      };
    });

    dependencyTotalEndpoints.set({ dependency: this.dependency }, urls.length);
    if (options.register !== false) registerPool(this);
    this.publishHealth();
  }

  get urls(): string[] {
    return this.endpoints.map((e) => e.url);
  }

  // ── Freshness ────────────────────────────────────────────────────────

  /**
   * Pool tip. With three or more reporting endpoints the second-highest
   * ledger is used, so a single endpoint claiming a far-future ledger cannot
   * mark every honest endpoint stale.
   */
  tipLedger(): number | null {
    const ledgers = this.endpoints
      .filter((e) => e.ledger !== null && this.observationFresh(e))
      .map((e) => e.ledger as number)
      .sort((a, b) => b - a);
    if (ledgers.length === 0) return null;
    return ledgers.length >= 3 ? ledgers[1] : ledgers[0];
  }

  private observationFresh(ep: EndpointState<C>): boolean {
    return this.now() - ep.ledgerObservedAt <= this.maxObservationAgeMs;
  }

  private lagOf(ep: EndpointState<C>, tip: number | null): number | null {
    if (ep.ledger === null || tip === null) return null;
    return tip - ep.ledger;
  }

  private isFresh(ep: EndpointState<C>, tip = this.tipLedger()): boolean {
    if (!this.ledgerAware) return true;
    if (ep.ledger === null || !this.observationFresh(ep)) return false;
    if (ep.ingestLagLedgers > this.maxLagLedgers) return false;
    const lag = this.lagOf(ep, tip);
    // Behind the tip is stale; far ahead of it is inconsistent.
    return lag !== null && Math.abs(lag) <= this.maxLagLedgers;
  }

  private async ensureFreshObservations(): Promise<void> {
    if (!this.ledgerAware) return;
    if (this.endpoints.some((e) => e.ledger !== null && this.observationFresh(e))) {
      return;
    }
    await this.refreshHealth();
  }

  // ── Health probing ───────────────────────────────────────────────────

  /** Probe every endpoint once. Concurrent callers share one round. */
  refreshHealth(): Promise<PoolStatus> {
    if (!this.refreshing) {
      this.refreshing = this.probeAll().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async probeAll(): Promise<PoolStatus> {
    if (this.probe) {
      const probe = this.probe;
      await Promise.all(
        this.endpoints.map(async (ep) => {
          try {
            const res = await withTimeout(
              probe(ep.client, ep.url),
              this.requestTimeoutMs,
              `${this.dependency}.probe`,
            );
            ep.probeHealthy = true;
            if (typeof res.ledger === "number" && Number.isFinite(res.ledger)) {
              ep.ledger = res.ledger;
              ep.ledgerObservedAt = this.now();
            }
            ep.ingestLagLedgers = Math.max(0, res.ingestLagLedgers ?? 0);
          } catch (err) {
            ep.probeHealthy = false;
            log("warn", "endpoint_probe_failed", {
              dependency: this.dependency,
              endpoint: ep.label,
              error: (err as Error).message,
            });
          }
        }),
      );
    }
    this.publishHealth();
    return this.getStatus();
  }

  private isEligible(
    ep: EndpointState<C>,
    rule: FallbackRule,
    tip: number | null,
  ): boolean {
    if (ep.breaker.getState() === "open") return false;
    if (ep.cooldownUntil > this.now()) return false;
    if (!ep.probeHealthy) return false;
    if (rule.requireFresh && !this.isFresh(ep, tip)) return false;
    return true;
  }

  private publishHealth(): void {
    const tip = this.tipLedger();
    let available = 0;
    for (const ep of this.endpoints) {
      const eligible = this.isEligible(ep, FALLBACK_MATRIX.read, tip);
      if (eligible) available++;
      const labels = { dependency: this.dependency, endpoint: ep.label };
      endpointHealthy.set(labels, eligible ? 1 : 0);
      endpointLatencySeconds.set(labels, ep.latencyEwmaMs / 1000);
      const lag = this.lagOf(ep, tip);
      if (lag !== null) endpointLedgerLag.set(labels, Math.max(lag, ep.ingestLagLedgers));
    }
    dependencyAvailableEndpoints.set({ dependency: this.dependency }, available);

    if (!this.serviceName) return;
    if (available === 0) {
      markUnavailable(this.serviceName, `no eligible ${this.dependency} endpoint`);
    } else if (available < this.endpoints.length) {
      markDegraded(
        this.serviceName,
        `${available}/${this.endpoints.length} ${this.dependency} endpoints eligible`,
      );
    } else {
      markHealthy(this.serviceName);
    }
  }

  // ── Selection ────────────────────────────────────────────────────────

  private score(ep: EndpointState<C>): number {
    const reliability = (1 - ep.errorEwma) ** 2;
    return Math.max(0.01, reliability / (1 + ep.latencyEwmaMs / 250));
  }

  /**
   * Health-weighted pick: untried eligible endpoints first, chosen at random
   * in proportion to score so load spreads instead of piling onto one URL.
   * Already-tried endpoints are reused only when nothing else is left.
   */
  private select(
    opClass: OperationClass,
    rule: FallbackRule,
    tried: Set<EndpointState<C>>,
  ): EndpointState<C> | null {
    const tip = this.tipLedger();
    let candidates = this.endpoints.filter((ep) => this.isEligible(ep, rule, tip));

    if (candidates.length === 0 && rule.requireFresh) {
      endpointStaleRejectedTotal.inc({ dependency: this.dependency, op_class: opClass });
      return null;
    }
    if (candidates.length === 0) {
      // Last resort when every probe failed: the probe path can be blocked
      // while the API works, so try anything whose breaker is not open.
      candidates = this.endpoints.filter(
        (ep) => ep.breaker.getState() !== "open" && ep.cooldownUntil <= this.now(),
      );
    }
    const untried = candidates.filter((ep) => !tried.has(ep));
    const pool = untried.length > 0 ? untried : candidates;
    if (pool.length === 0) return null;

    const total = pool.reduce((sum, ep) => sum + this.score(ep), 0);
    let pick = this.random() * total;
    for (const ep of pool) {
      pick -= this.score(ep);
      if (pick <= 0) return ep;
    }
    return pool[pool.length - 1];
  }

  // ── Calls ────────────────────────────────────────────────────────────

  private recordOutcome(ep: EndpointState<C>, latencyMs: number, failed: boolean): void {
    ep.latencyEwmaMs =
      ep.latencyEwmaMs === 0
        ? latencyMs
        : EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * ep.latencyEwmaMs;
    ep.errorEwma = EWMA_ALPHA * (failed ? 1 : 0) + (1 - EWMA_ALPHA) * ep.errorEwma;
  }

  /**
   * One attempt against one endpoint through its breaker. Client errors
   * (4xx: bad request, tx_failed, not found) mean the endpoint is healthy and
   * the request is wrong, and a 429 means it is healthy but busy — cooldown
   * handles that for exactly as long as Retry-After asks — so neither is
   * charged to the breaker.
   */
  private async callEndpoint<R>(
    ep: EndpointState<C>,
    opClass: OperationClass,
    fn: (client: C, ctx: { url: string }) => Promise<R>,
  ): Promise<R> {
    const start = this.now();
    let notCharged: { err: unknown; kind: FailureKind } | null = null;
    const labels = { dependency: this.dependency, endpoint: ep.label, op_class: opClass };
    try {
      const result = await ep.breaker.execute(async () => {
        try {
          return await withTimeout(
            fn(ep.client, { url: ep.url }),
            this.requestTimeoutMs,
            `${this.dependency}.${opClass}`,
          );
        } catch (err) {
          const { kind } = classifyError(err);
          if (kind === "client" || kind === "rate_limited") {
            notCharged = { err, kind };
            return undefined as R;
          }
          throw err;
        }
      });
      if (notCharged) {
        const { err, kind } = notCharged as { err: unknown; kind: FailureKind };
        this.recordOutcome(ep, this.now() - start, kind === "rate_limited");
        endpointRequestsTotal.inc({ ...labels, outcome: kind });
        throw err;
      }
      this.recordOutcome(ep, this.now() - start, false);
      endpointRequestsTotal.inc({ ...labels, outcome: "success" });
      return result;
    } catch (err) {
      if (notCharged) throw err;
      this.recordOutcome(ep, this.now() - start, true);
      endpointRequestsTotal.inc({ ...labels, outcome: classifyError(err).kind });
      throw err;
    }
  }

  /**
   * Run `fn` against the pool under the operation class's fallback rule and
   * the shared retry policy. Client errors are rethrown untouched; exhausted
   * attempts throw DependencyUnavailableError (or StaleReadError when no
   * endpoint was fresh enough to try).
   */
  async execute<R>(
    opClass: OperationClass,
    fn: (client: C, ctx: { url: string }) => Promise<R>,
  ): Promise<R> {
    const rule = FALLBACK_MATRIX[opClass];
    if (rule.requireFresh) await this.ensureFreshObservations();
    this.budget.recordRequest();

    const tried = new Set<EndpointState<C>>();
    const primary = this.select(opClass, rule, tried);
    let ep: EndpointState<C> | null = primary;
    let firstFailureAt: number | null = null;
    let lastError: unknown;

    try {
      for (let attempt = 0; ep && attempt < this.retry.maxAttempts; attempt++) {
        try {
          const result = await this.callEndpoint(ep, opClass, fn);
          if (firstFailureAt !== null && ep !== primary) {
            endpointFailoverTotal.inc({ dependency: this.dependency, op_class: opClass });
            endpointFailoverLatency.observe(
              { dependency: this.dependency },
              (this.now() - firstFailureAt) / 1000,
            );
            log("warn", "endpoint_failover", {
              dependency: this.dependency,
              opClass,
              from: primary?.label,
              to: ep.label,
            });
          }
          return result;
        } catch (err) {
          const failure = classifyError(err);
          if (failure.kind === "client") throw err;
          lastError = err;
          firstFailureAt ??= this.now();
          tried.add(ep);

          if (failure.kind === "rate_limited") {
            ep.cooldownUntil =
              this.now() + (failure.retryAfterMs ?? this.retry.baseDelayMs * 5);
          }
          if (failure.kind === "ambiguous" && !rule.retryAmbiguous) break;
          if (attempt + 1 >= this.retry.maxAttempts) break;

          // Choose the next endpoint before spending budget or sleeping, so
          // a call with nowhere left to go (all cooling down / open) stops
          // immediately instead of waiting to fail.
          const failed: EndpointState<C> = ep;
          const next = rule.failover ? this.select(opClass, rule, tried) : failed;
          if (!next) break;
          if (!this.budget.tryAcquire()) {
            endpointRetryBudgetExhaustedTotal.inc({ dependency: this.dependency });
            break;
          }
          endpointRetriesTotal.inc({
            dependency: this.dependency,
            op_class: opClass,
            reason: failure.kind,
          });
          // Moving to an endpoint not yet tried in this call needs no delay;
          // hitting one again backs off, and never sooner than Retry-After.
          if (tried.has(next)) {
            const retryAfter =
              next === failed && failure.kind === "rate_limited"
                ? failure.retryAfterMs
                : undefined;
            await this.sleep(
              computeBackoffMs(attempt, this.retry, this.random, retryAfter),
            );
          }
          ep = next;
        }
      }
    } finally {
      this.publishHealth();
    }

    if (lastError === undefined && rule.requireFresh) {
      throw new StaleReadError(this.dependency, opClass, this.maxLagLedgers);
    }
    throw new DependencyUnavailableError(this.dependency, opClass, lastError);
  }

  /**
   * Ask up to `quorum` fresh endpoints in parallel and arbitrate their
   * answers (see `arbitrate`). `corroborated` is false when fewer than two
   * endpoints answered, so callers that need agreement can refuse.
   */
  async arbitratedRead<V>(
    fn: (client: C, ctx: { url: string }) => Promise<LedgerStamped<V>>,
    options: { quorum?: number; equals?: (a: V, b: V) => boolean } = {},
  ): Promise<ArbitrationResult<V> & { corroborated: boolean }> {
    const opClass: OperationClass = "consistent_read";
    const rule = FALLBACK_MATRIX[opClass];
    await this.ensureFreshObservations();

    const tip = this.tipLedger();
    const quorum = Math.max(1, options.quorum ?? this.arbitrationQuorum);
    const chosen = this.endpoints
      .filter((ep) => this.isEligible(ep, rule, tip))
      .sort((a, b) => this.score(b) - this.score(a))
      .slice(0, quorum);
    if (chosen.length === 0) {
      endpointStaleRejectedTotal.inc({ dependency: this.dependency, op_class: opClass });
      throw new StaleReadError(this.dependency, opClass, this.maxLagLedgers);
    }

    const settled = await Promise.allSettled(
      chosen.map((ep) => this.callEndpoint(ep, opClass, fn)),
    );
    this.publishHealth();

    const responses: ArbitrationInput<V>[] = [];
    let lastError: unknown;
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        responses.push({ ...s.value, endpoint: chosen[i].label });
      } else {
        lastError = s.reason;
      }
    });
    if (responses.length === 0) {
      throw new DependencyUnavailableError(this.dependency, opClass, lastError);
    }

    try {
      const result = arbitrate(
        responses,
        this.maxLagLedgers,
        options.equals,
        this.dependency,
      );
      if (result.superseded.length || result.droppedStale.length) {
        log("info", "endpoint_arbitration", {
          dependency: this.dependency,
          ledger: result.ledger,
          winner: result.endpoint,
          superseded: result.superseded,
          droppedStale: result.droppedStale,
        });
      }
      return { ...result, corroborated: result.agreeing.length >= 2 };
    } catch (err) {
      if (err instanceof EndpointDisagreementError) {
        endpointDisagreementTotal.inc({ dependency: this.dependency });
        log("error", "endpoint_disagreement", {
          dependency: this.dependency,
          ledger: err.ledger,
          endpoints: err.endpoints,
        });
      }
      throw err;
    }
  }

  getStatus(): PoolStatus {
    const tip = this.tipLedger();
    const endpoints = this.endpoints.map((ep) => ({
      endpoint: ep.label,
      eligible: this.isEligible(ep, FALLBACK_MATRIX.read, tip),
      fresh: this.isFresh(ep, tip),
      probeHealthy: ep.probeHealthy,
      breakerState: ep.breaker.getState(),
      latencyEwmaMs: Math.round(ep.latencyEwmaMs),
      errorRateEwma: Number(ep.errorEwma.toFixed(3)),
      ledger: ep.ledger,
      lagLedgers: this.lagOf(ep, tip),
      cooldownRemainingMs: Math.max(0, ep.cooldownUntil - this.now()),
    }));
    return {
      dependency: this.dependency,
      totalEndpoints: endpoints.length,
      availableEndpoints: endpoints.filter((e) => e.eligible).length,
      freshEndpoints: endpoints.filter((e) => e.fresh).length,
      tipLedger: tip,
      maxLagLedgers: this.maxLagLedgers,
      endpoints,
    };
  }
}

export function createEndpointPool<C>(options: EndpointPoolOptions<C>): EndpointPool<C> {
  return new EndpointPool(options);
}

// ============================================
// REGISTRY & HEALTH MONITOR
// ============================================

const pools = new Map<string, EndpointPool<unknown>>();
const extraProbes = new Map<string, () => Promise<unknown>>();
let monitorTimer: ReturnType<typeof setInterval> | null = null;

function registerPool(pool: EndpointPool<any>): void {
  pools.set(pool.dependency, pool);
}

/** Health checks for pools not built on EndpointPool (the Soroban RPC pool). */
export function registerHealthProbe(name: string, fn: () => Promise<unknown>): void {
  extraProbes.set(name, fn);
}

export function getEndpointPoolStatuses(): PoolStatus[] {
  return Array.from(pools.values()).map((p) => p.getStatus());
}

export async function refreshAllEndpointHealth(): Promise<void> {
  await Promise.allSettled([
    ...Array.from(pools.values()).map((p) => p.refreshHealth()),
    ...Array.from(extraProbes.values()).map((fn) => fn()),
  ]);
}

export function startEndpointHealthMonitor(intervalMs: number): void {
  if (monitorTimer) return;
  void refreshAllEndpointHealth();
  monitorTimer = setInterval(() => void refreshAllEndpointHealth(), intervalMs);
  monitorTimer.unref?.();
}

export function stopEndpointHealthMonitor(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}
