// Endpoint-fault harness for the shared endpoint pool (#745).
//
// Each fake endpoint can be blackholed, hung, rate-limited, made to lag the
// chain, or made to return a divergent value, so the drills from SPIKE-071
// (blackhole, 429 storm, finality-lag injection, dual-RPC divergence) run
// deterministically without live dependencies.

import test from "node:test";
import assert from "node:assert/strict";

import {
  arbitrate,
  classifyError,
  computeBackoffMs,
  createEndpointPool,
  DependencyUnavailableError,
  EndpointDisagreementError,
  FALLBACK_MATRIX,
  HttpStatusError,
  parseRetryAfterMs,
  RetryBudget,
  StaleReadError,
  type EndpointPoolOptions,
} from "../src/services/endpoint-pool.js";
import { RpcPoolManager } from "../src/services/stellar.js";
import type { RpcServerPort } from "../src/services/interfaces.js";

type Mode =
  | "ok"
  | "blackhole"
  | "hang"
  | "rate_limit"
  | "unavailable"
  | "client_error"
  | "probe_down";

class FaultyEndpoint {
  mode: Mode = "ok";
  ledger = 1000;
  value: unknown = "root-A";
  retryAfterMs = 1000;
  calls = 0;

  constructor(readonly url: string) {}

  async call(): Promise<{ value: unknown; ledger: number }> {
    this.calls++;
    switch (this.mode) {
      case "blackhole":
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      case "hang":
        return new Promise(() => {});
      case "rate_limit":
        throw new HttpStatusError(429, "Too Many Requests", this.retryAfterMs);
      case "unavailable":
        throw new HttpStatusError(503, "Service Unavailable");
      case "client_error":
        throw new HttpStatusError(400, "tx_failed");
      default:
        return { value: this.value, ledger: this.ledger };
    }
  }

  async probe(): Promise<{ ledger: number }> {
    if (this.mode === "blackhole" || this.mode === "probe_down") {
      throw new Error("probe failed");
    }
    return { ledger: this.ledger };
  }
}

let poolSeq = 0;

function harness(
  count: number,
  options: Partial<EndpointPoolOptions<FaultyEndpoint>> & { ledgerAware?: boolean } = {},
) {
  const id = `drill_${++poolSeq}`;
  const endpoints = Array.from(
    { length: count },
    (_, i) => new FaultyEndpoint(`https://ep${i}.${id}.test`),
  );
  const byUrl = new Map(endpoints.map((e) => [e.url, e]));
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const pool = createEndpointPool<FaultyEndpoint>({
    dependency: id,
    urls: endpoints.map((e) => e.url),
    clientFactory: (url) => byUrl.get(url)!,
    probe: options.ledgerAware === false ? undefined : (client) => client.probe(),
    register: false,
    maxLagLedgers: 5,
    requestTimeoutMs: 50,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    // Deterministic: weighted pick always lands on the first candidate.
    random: () => 0,
    ...options,
  });
  return {
    pool,
    endpoints,
    sleeps,
    advance: (ms: number) => {
      clock += ms;
    },
    totalCalls: () => endpoints.reduce((n, e) => n + e.calls, 0),
  };
}

const read = (ep: FaultyEndpoint) => ep.call();

// ── Fallback matrix ───────────────────────────────────────────────────────

test("fallback matrix: writes that can duplicate a transfer never fail over or retry ambiguously", () => {
  assert.deepEqual(FALLBACK_MATRIX.submit_non_idempotent, {
    failover: false,
    requireFresh: false,
    retryAmbiguous: false,
  });
  assert.equal(FALLBACK_MATRIX.submit_idempotent.failover, true);
  assert.equal(FALLBACK_MATRIX.consistent_read.requireFresh, true);
  assert.equal(FALLBACK_MATRIX.quote.requireFresh, true);
  assert.equal(FALLBACK_MATRIX.read.requireFresh, false);
});

// ── Blackhole drill ───────────────────────────────────────────────────────

test("blackhole drill: a dead primary fails over to a healthy endpoint", async () => {
  const h = harness(2, { ledgerAware: false });
  h.endpoints[0].mode = "blackhole";

  const result = await h.pool.execute("read", read);

  assert.equal(result.value, "root-A");
  assert.equal(h.endpoints[0].calls, 1);
  assert.equal(h.endpoints[1].calls, 1);
});

test("blackhole drill: with every endpoint down the call fails, then breakers fail fast", async () => {
  const h = harness(2, {
    ledgerAware: false,
    breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
  });
  for (const ep of h.endpoints) ep.mode = "blackhole";

  for (let i = 0; i < 3; i++) {
    await assert.rejects(h.pool.execute("read", read), DependencyUnavailableError);
  }
  const callsWhenOpen = h.totalCalls();
  await assert.rejects(h.pool.execute("read", read), DependencyUnavailableError);
  assert.equal(h.totalCalls(), callsWhenOpen, "open breakers must not be called");
  assert.equal(h.pool.getStatus().availableEndpoints, 0);
});

test("hung endpoint is cut off by the request timeout and rerouted", async () => {
  const h = harness(2, { ledgerAware: false, requestTimeoutMs: 20 });
  h.endpoints[0].mode = "hang";

  const result = await h.pool.execute("read", read);
  assert.equal(result.value, "root-A");
  assert.equal(h.endpoints[1].calls, 1);
});

// ── Rate-limit drill ──────────────────────────────────────────────────────

test("429 drill: a rate-limited endpoint is cooled down for every caller (no retry storm)", async () => {
  const h = harness(1, { ledgerAware: false });
  h.endpoints[0].mode = "rate_limit";
  h.endpoints[0].retryAfterMs = 2_000;

  const results = await Promise.allSettled(
    Array.from({ length: 100 }, () => h.pool.execute("read", read)),
  );
  assert.ok(results.every((r) => r.status === "rejected"));
  // 100 first attempts are real traffic; none of them may be retried into
  // an endpoint that just said Retry-After.
  assert.equal(h.endpoints[0].calls, 100);

  // While cooling down, new calls fail fast without touching the endpoint.
  await assert.rejects(h.pool.execute("read", read), DependencyUnavailableError);
  assert.equal(h.endpoints[0].calls, 100);

  // After Retry-After the endpoint is used again.
  h.endpoints[0].mode = "ok";
  h.advance(2_001);
  assert.equal((await h.pool.execute("read", read)).value, "root-A");
});

test("429 drill: a rate-limited endpoint sheds load to its peer", async () => {
  const h = harness(2, { ledgerAware: false });
  h.endpoints[0].mode = "rate_limit";

  for (let i = 0; i < 20; i++) await h.pool.execute("read", read);

  assert.equal(h.endpoints[0].calls, 1, "only the first call meets the 429");
  assert.equal(h.endpoints[1].calls, 20);
});

test("429 on a pinned (non-idempotent) call waits out Retry-After before retrying", async () => {
  const h = harness(1, { ledgerAware: false });
  h.endpoints[0].mode = "rate_limit";
  h.endpoints[0].retryAfterMs = 1_500;

  await assert.rejects(h.pool.execute("submit_non_idempotent", read));
  assert.ok(h.sleeps.length > 0);
  assert.ok(h.sleeps.every((ms) => ms >= 1_500), `slept ${h.sleeps}`);
});

test("retry budget caps retries under a sustained outage", async () => {
  const h = harness(2, {
    ledgerAware: false,
    retry: { maxAttempts: 3, budgetRatio: 0, budgetMinRetries: 5 },
    breaker: { failureThreshold: 10_000, resetTimeoutMs: 60_000 },
  });
  for (const ep of h.endpoints) ep.mode = "unavailable";

  for (let i = 0; i < 50; i++) {
    await assert.rejects(h.pool.execute("read", read));
  }
  // 50 first attempts + at most 5 budgeted retries, instead of 150.
  assert.ok(h.totalCalls() <= 55, `calls=${h.totalCalls()}`);
});

test("RetryBudget allows a ratio of traffic and the floor", () => {
  let t = 0;
  const budget = new RetryBudget(
    { budgetRatio: 0.1, budgetMinRetries: 2, budgetWindowMs: 1_000 },
    () => t,
  );
  for (let i = 0; i < 50; i++) budget.recordRequest();
  let granted = 0;
  while (budget.tryAcquire()) granted++;
  assert.equal(granted, 5);
  t += 1_001;
  assert.equal(budget.tryAcquire(), true, "window slides");
});

// ── Write safety ──────────────────────────────────────────────────────────

test("non-idempotent submit is never retried after an ambiguous timeout", async () => {
  const h = harness(2, { ledgerAware: false, requestTimeoutMs: 20 });
  h.endpoints[0].mode = "hang";

  await assert.rejects(
    h.pool.execute("submit_non_idempotent", read),
    DependencyUnavailableError,
  );
  assert.equal(h.endpoints[0].calls, 1);
  assert.equal(h.endpoints[1].calls, 0, "must not move to another endpoint");
});

test("non-idempotent submit retries the same endpoint when the request never left", async () => {
  const h = harness(2, { ledgerAware: false });
  let attempts = 0;
  const result = await h.pool.execute("submit_non_idempotent", async (ep) => {
    attempts++;
    if (attempts === 1) {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    }
    return ep.url;
  });
  assert.equal(result, h.endpoints[0].url);
});

test("idempotent submit resends the same envelope to another endpoint after a 504", async () => {
  const h = harness(2, { ledgerAware: false });
  const seen: string[] = [];
  const result = await h.pool.execute("submit_idempotent", async (ep) => {
    seen.push(ep.url);
    if (seen.length === 1) throw new HttpStatusError(504, "Gateway Timeout");
    return "applied";
  });
  assert.equal(result, "applied");
  assert.deepEqual(seen, [h.endpoints[0].url, h.endpoints[1].url]);
});

test("client errors are rethrown untouched and do not trip the breaker", async () => {
  const h = harness(1, {
    ledgerAware: false,
    breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
  });
  h.endpoints[0].mode = "client_error";
  for (let i = 0; i < 5; i++) {
    await assert.rejects(h.pool.execute("read", read), /tx_failed/);
  }
  assert.equal(h.endpoints[0].calls, 5, "no retries on 4xx");
  assert.equal(h.pool.getStatus().endpoints[0].breakerState, "closed");
});

// ── Finality-lag drill ────────────────────────────────────────────────────

test("finality-lag drill: consistent reads skip an endpoint behind the bound", async () => {
  const h = harness(2);
  h.endpoints[0].ledger = 980; // 20 behind
  h.endpoints[1].ledger = 1000;
  await h.pool.refreshHealth();

  for (let i = 0; i < 5; i++) await h.pool.execute("consistent_read", read);
  assert.equal(h.endpoints[0].calls, 0);
  assert.equal(h.endpoints[1].calls, 5);

  // Plain reads tolerate staleness and may use the lagging endpoint.
  await h.pool.execute("read", read);
  assert.equal(h.endpoints[0].calls, 1);
});

test("finality-lag drill: with no fresh endpoint, witness reads fail closed", async () => {
  const h = harness(2);
  h.endpoints[0].ledger = 980;
  h.endpoints[1].ledger = 1000;
  await h.pool.refreshHealth();
  h.endpoints[1].mode = "probe_down";
  await h.pool.refreshHealth();

  await assert.rejects(h.pool.execute("consistent_read", read), StaleReadError);
  await assert.rejects(h.pool.execute("quote", read), StaleReadError);
  assert.equal(h.endpoints[0].calls, 0, "stale endpoint must never serve a witness read");
});

test("finality-lag drill: ledger observations expire", async () => {
  const h = harness(1, { maxObservationAgeMs: 10_000 });
  await h.pool.refreshHealth();
  assert.equal(h.pool.getStatus().freshEndpoints, 1);
  h.advance(10_001);
  assert.equal(h.pool.getStatus().freshEndpoints, 0);
  // A consistent read re-probes on demand instead of trusting old data.
  await h.pool.execute("consistent_read", read);
  assert.equal(h.pool.getStatus().freshEndpoints, 1);
});

test("an endpoint claiming a far-future ledger cannot mark honest endpoints stale", async () => {
  const h = harness(3);
  h.endpoints[0].ledger = 1000;
  h.endpoints[1].ledger = 1001;
  h.endpoints[2].ledger = 9_999_999;
  await h.pool.refreshHealth();

  const status = h.pool.getStatus();
  assert.equal(status.tipLedger, 1001);
  assert.deepEqual(
    status.endpoints.map((e) => e.fresh),
    [true, true, false],
  );
});

test("Horizon-style ingest lag beyond the bound makes an endpoint stale", async () => {
  const id = `ingest_${++poolSeq}`;
  const pool = createEndpointPool<null>({
    dependency: id,
    urls: [`https://a.${id}.test`],
    clientFactory: () => null,
    probe: async () => ({ ledger: 1000, ingestLagLedgers: 50 }),
    register: false,
    maxLagLedgers: 5,
  });
  await pool.refreshHealth();
  assert.equal(pool.getStatus().freshEndpoints, 0);
  await assert.rejects(pool.execute("quote", async () => "q"), StaleReadError);
});

// ── Dual-RPC divergence drill ─────────────────────────────────────────────

test("arbitrate: highest ledger wins; older differing values are superseded", () => {
  const result = arbitrate(
    [
      { endpoint: "a", ledger: 1000, value: "old-root" },
      { endpoint: "b", ledger: 1002, value: "new-root" },
      { endpoint: "c", ledger: 900, value: "ancient-root" },
    ],
    5,
  );
  assert.equal(result.value, "new-root");
  assert.equal(result.ledger, 1002);
  assert.deepEqual(result.superseded, ["a"]);
  assert.deepEqual(result.droppedStale, ["c"]);
});

test("arbitrate: same ledger, different values fails closed", () => {
  assert.throws(
    () =>
      arbitrate(
        [
          { endpoint: "a", ledger: 1000, value: "root-A" },
          { endpoint: "b", ledger: 1000, value: "root-B" },
        ],
        5,
      ),
    EndpointDisagreementError,
  );
});

test("dual-RPC divergence drill: arbitrated pool read refuses to pick a side", async () => {
  const h = harness(2);
  h.endpoints[1].value = "root-B";
  await h.pool.refreshHealth();

  await assert.rejects(h.pool.arbitratedRead(read), EndpointDisagreementError);
});

test("arbitrated pool read: agreeing endpoints are corroborated", async () => {
  const h = harness(3);
  await h.pool.refreshHealth();
  const result = await h.pool.arbitratedRead(read, { quorum: 2 });
  assert.equal(result.value, "root-A");
  assert.equal(result.corroborated, true);
  assert.equal(h.totalCalls(), 2);
});

test("arbitrated pool read: one endpoint down still answers, uncorroborated", async () => {
  const h = harness(2);
  await h.pool.refreshHealth();
  h.endpoints[0].mode = "unavailable";
  const result = await h.pool.arbitratedRead(read);
  assert.equal(result.value, "root-A");
  assert.equal(result.corroborated, false);
});

// ── Soroban RPC pool ──────────────────────────────────────────────────────

function rpcServer(state: {
  ledger: number;
  healthy?: boolean;
  root?: string;
}): RpcServerPort & { id: number } {
  return {
    id: state.ledger,
    getHealth: async () => {
      if (state.healthy === false) throw new Error("down");
      return { status: "healthy" };
    },
    getLatestLedger: async () => ({ sequence: state.ledger }),
    simulateTransaction: async () => ({}),
    sendTransaction: async () => ({ status: "PENDING" }),
    getTransaction: async () => ({ status: "SUCCESS" }),
    getAccount: async () => ({}),
  } as RpcServerPort & { id: number };
}

test("RpcPoolManager: routing skips an RPC lagging past the finality bound", async () => {
  const states = {
    "rpc-fresh": { ledger: 5000 },
    "rpc-lagging": { ledger: 4900 },
  };
  const pool = new RpcPoolManager(
    Object.keys(states),
    undefined,
    (url) => rpcServer(states[url as keyof typeof states]),
    { maxLagLedgers: 5 },
  );
  const statuses = await pool.checkHealth();
  assert.deepEqual(
    statuses.map((s) => [s.url, s.lagLedgers, s.fresh]),
    [
      ["rpc-fresh", 0, true],
      ["rpc-lagging", 100, false],
    ],
  );
  for (let i = 0; i < 4; i++) {
    assert.equal((pool.getActiveServer() as any).id, 5000);
  }
});

test("RpcPoolManager: readArbitrated fails closed on same-ledger root divergence", async () => {
  const states = {
    "rpc-a": { ledger: 7000, root: "0xaaa" },
    "rpc-b": { ledger: 7000, root: "0xbbb" },
  };
  const servers = new Map(
    Object.entries(states).map(([url, s]) => [url, rpcServer(s)]),
  );
  const pool = new RpcPoolManager(
    Object.keys(states),
    undefined,
    (url) => servers.get(url)!,
    { maxLagLedgers: 5 },
  );
  const rootOf = (srv: RpcServerPort) =>
    [...servers.entries()].find(([, s]) => s === srv)![0] as keyof typeof states;

  await assert.rejects(
    pool.readArbitrated(async (srv) => ({
      value: states[rootOf(srv)].root,
      ledger: states[rootOf(srv)].ledger,
    })),
    EndpointDisagreementError,
  );
});

test("RpcPoolManager: readArbitrated refuses when every RPC is down", async () => {
  const pool = new RpcPoolManager(
    ["rpc-down"],
    undefined,
    () => rpcServer({ ledger: 1, healthy: false }),
    { maxLagLedgers: 5 },
  );
  await assert.rejects(
    pool.readArbitrated(async () => ({ value: "x", ledger: 1 })),
    StaleReadError,
  );
});

// ── Classification & backoff ──────────────────────────────────────────────

test("classifyError separates not-sent, ambiguous, throttled and client failures", () => {
  assert.equal(classifyError(new HttpStatusError(429, "x", 500)).kind, "rate_limited");
  assert.equal(classifyError(new HttpStatusError(429, "x", 500)).retryAfterMs, 500);
  assert.equal(classifyError(new HttpStatusError(503, "x")).kind, "unavailable");
  assert.equal(classifyError(new HttpStatusError(504, "x")).kind, "ambiguous");
  assert.equal(classifyError(new HttpStatusError(400, "x")).kind, "client");
  assert.equal(classifyError({ response: { status: 404 } }).kind, "client");
  assert.equal(
    classifyError({ response: { status: 429, headers: { "retry-after": "3" } } })
      .retryAfterMs,
    3000,
  );
  assert.equal(classifyError({ code: "ECONNREFUSED" }).kind, "unavailable");
  assert.equal(classifyError({ code: "ECONNRESET" }).kind, "ambiguous");
  assert.equal(classifyError(new Error("mystery")).kind, "ambiguous");
});

test("computeBackoffMs is capped, jittered, and never undercuts Retry-After", () => {
  const policy = { baseDelayMs: 100, maxDelayMs: 1_000 };
  assert.equal(computeBackoffMs(0, policy, () => 0), 50);
  assert.equal(computeBackoffMs(0, policy, () => 1), 100);
  assert.equal(computeBackoffMs(10, policy, () => 1), 1_000);
  assert.equal(computeBackoffMs(0, policy, () => 1, 5_000), 5_000);
});

test("parseRetryAfterMs accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMs("2"), 2000);
  const now = Date.parse("2026-10-18T00:00:00Z");
  assert.equal(parseRetryAfterMs("Sun, 18 Oct 2026 00:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfterMs(undefined), undefined);
});
