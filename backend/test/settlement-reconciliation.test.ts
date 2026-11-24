/**
 * Callback-chaos tests for settlement reconciliation (#refactor:
 * registry-settlement-voting-composition).
 *
 * Exercises duplicate delivery, out-of-order callbacks, deterministic conflict
 * resolution, fee exactness, dispute evidence and aging detection through an
 * injected in-memory store, ledger store, clock and timer port.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createInMemorySettlementStore,
  createSettlementReconciliation,
  isTerminal,
  reconcileFees,
  type AnchorCallbackEvent,
  type LoggerPort,
  type SettlementRecord,
  type TimersPort,
} from "../src/services/settlementReconciliation.js";
import { createInMemoryLedgerStore, validatePostingGroup } from "../src/services/ledger.js";

const T0 = 1_700_000_000_000;

interface LogEntry {
  level: string;
  event: string;
  meta: Record<string, unknown>;
}

function makeHarness() {
  let now = T0;
  const logEntries: LogEntry[] = [];
  const logger: LoggerPort = {
    debug: () => {},
    info: (event, meta) => logEntries.push({ level: "info", event, meta: meta ?? {} }),
    warn: (event, meta) => logEntries.push({ level: "warn", event, meta: meta ?? {} }),
    error: (event, meta) => logEntries.push({ level: "error", event, meta: meta ?? {} }),
    log: (level, event, meta) => logEntries.push({ level, event, meta: meta ?? {} }),
  };
  const store = createInMemorySettlementStore();
  const ledgerStore = createInMemoryLedgerStore();
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let handleCounter = 0;
  const timers: TimersPort = {
    setInterval(fn, ms) {
      const handle = ++handleCounter;
      intervals.set(handle, { fn, ms });
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
  };
  const reconciler = createSettlementReconciliation({
    store,
    ledgerStore,
    logger,
    timers,
    now: () => now,
  });
  return {
    reconciler,
    store,
    ledgerStore,
    logEntries,
    timers,
    intervals,
    advance(ms: number) {
      now += ms;
    },
  };
}

function event(overrides: Partial<AnchorCallbackEvent>): AnchorCallbackEvent {
  return {
    eventId: "e-default",
    anchor: "USDC",
    externalTxId: "tx-1",
    kind: "anchor_confirmed",
    ledgerVersion: 1,
    observedAt: T0,
    ...overrides,
  };
}

test("chaos: duplicate callbacks converge to one terminal state and one posting group", async () => {
  const h = makeHarness();
  const confirmed = await h.reconciler.handleAnchorCallback(
    event({ eventId: "confirm-1", kind: "anchor_confirmed", ledgerVersion: 10, observedAt: T0, grossMinor: 10_000, netMinor: 9_700, feeBreakdown: [{ code: "anchor", amountMinor: 300 }] }),
  );
  assert.equal(confirmed.state, "ANCHOR_CONFIRMED");
  assert.equal(confirmed.applied, true);

  const settled = await h.reconciler.handleAnchorCallback(
    event({ eventId: "settle-1", kind: "settled", ledgerVersion: 11, observedAt: T0 + 1_000 }),
  );
  assert.equal(settled.state, "SETTLED");
  assert.equal(settled.applied, true);
  assert.ok(settled.record.postingGroupId, "settlement must have a posting group");

  // Same event id redelivered: pure no-op returning the existing state.
  const duplicate = await h.reconciler.handleAnchorCallback(
    event({ eventId: "settle-1", kind: "settled", ledgerVersion: 11, observedAt: T0 + 1_000 }),
  );
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.state, "SETTLED");

  // A *different* event id arriving after the terminal state must not revert.
  const late = await h.reconciler.handleAnchorCallback(
    event({ eventId: "settle-late", kind: "settled", ledgerVersion: 12, observedAt: T0 + 2_000, grossMinor: 99_999 }),
  );
  assert.equal(late.reason, "terminal_noop");
  assert.equal(late.state, "SETTLED");
  assert.equal(late.record.grossMinor, 10_000, "terminal state data is immutable");

  const record = await h.reconciler.getRecord("USDC", "tx-1");
  assert.equal(record?.state, "SETTLED");
  assert.equal(isTerminal(record!.state), true);
  const transitions = await h.store.listTransitions("USDC:tx-1");
  assert.deepEqual(
    transitions.map((t) => `${t.fromState}->${t.toState}`),
    ["PENDING->ANCHOR_CONFIRMED", "ANCHOR_CONFIRMED->SETTLED"],
  );
  assert.equal((await h.ledgerStore.listGroups()).length, 1, "exactly one posting group");
});

test("chaos: out-of-order SETTLED cannot be reverted by a late confirmation", async () => {
  const h = makeHarness();
  const settled = await h.reconciler.handleAnchorCallback(
    event({ eventId: "settle-first", kind: "settled", ledgerVersion: 7, observedAt: T0 + 5_000, grossMinor: 5_000 }),
  );
  assert.equal(settled.state, "SETTLED");
  assert.equal(settled.reason, "applied");

  const transitions = await h.store.listTransitions("USDC:tx-1");
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.reason, "out_of_order_settled");

  const lateConfirm = await h.reconciler.handleAnchorCallback(
    event({ eventId: "confirm-late", kind: "anchor_confirmed", ledgerVersion: 1, observedAt: T0, grossMinor: 5_000 }),
  );
  assert.equal(lateConfirm.reason, "terminal_noop");
  assert.equal(lateConfirm.state, "SETTLED");
  assert.equal((await h.store.listTransitions("USDC:tx-1")).length, 1);
  assert.equal((await h.ledgerStore.listGroups()).length, 1);
  // The late callback is still recorded as evidence.
  assert.equal((await h.store.listCallbacks("USDC:tx-1")).length, 2);
});

test("chaos: conflict rule is deterministic regardless of arrival order", async () => {
  const early = event({
    eventId: "confirm-early",
    kind: "anchor_confirmed",
    ledgerVersion: 3,
    observedAt: T0 + 200,
    grossMinor: 1_000,
  });
  const late = event({
    eventId: "confirm-late",
    kind: "anchor_confirmed",
    ledgerVersion: 10,
    observedAt: T0 + 500,
    grossMinor: 9_999,
  });

  const a = makeHarness();
  await a.reconciler.handleAnchorCallback(late);
  const aLateApplied = await a.reconciler.handleAnchorCallback(early);
  assert.equal(aLateApplied.reason, "conflict_earlier_authority");

  const b = makeHarness();
  await b.reconciler.handleAnchorCallback(early);
  const bLateNoop = await b.reconciler.handleAnchorCallback(late);
  assert.equal(bLateNoop.reason, "conflict_later");

  const recordA = await a.reconciler.getRecord("USDC", "tx-1");
  const recordB = await b.reconciler.getRecord("USDC", "tx-1");
  assert.deepEqual(recordA?.authority, recordB?.authority);
  assert.deepEqual(recordA?.authority, { ledgerVersion: 3, observedAt: T0 + 200, eventId: "confirm-early" });
  assert.equal(recordA?.grossMinor, 1_000, "earlier authoritative payload wins");
  assert.equal(recordB?.grossMinor, 1_000);
  assert.equal(recordA?.state, recordB?.state);
});

test("fees: integer-minor reconciliation is exact and rejects drift", () => {
  const ok = reconcileFees({
    gross: 10_000,
    net: 9_700,
    feeBreakdown: [
      { code: "network", amountMinor: 100 },
      { code: "anchor", amountMinor: 200 },
    ],
  });
  assert.equal(ok.feesMinor, 300);
  assert.equal(ok.netMinor, 9_700);

  assert.throws(
    () => reconcileFees({ gross: 10_000, net: 9_600, feeBreakdown: [{ code: "anchor", amountMinor: 300 }] }),
    /does not reconcile/,
  );
  assert.throws(() => reconcileFees({ gross: 1.5, feeBreakdown: [] }), /safe integer/);
  assert.throws(
    () => reconcileFees({ gross: 100, feeBreakdown: [{ code: "too-big", amountMinor: 101 }] }),
    /exceeds gross/,
  );
  // Derived net when the caller does not supply an observed settled amount.
  assert.equal(reconcileFees({ gross: 1_000, feeBreakdown: [50, 50] }).netMinor, 900);
});

test("dispute: evidence bundle is complete and emits a ZV-010 event", async () => {
  const h = makeHarness();
  const feeBreakdown = [{ code: "anchor", amountMinor: 300 }];
  await h.reconciler.handleAnchorCallback(
    event({ eventId: "c1", kind: "anchor_confirmed", ledgerVersion: 1, observedAt: T0, grossMinor: 10_000, netMinor: 9_700, feeBreakdown }),
  );
  await h.reconciler.handleAnchorCallback(
    event({ eventId: "s1", kind: "settled", ledgerVersion: 2, observedAt: T0 + 100 }),
  );
  await h.reconciler.handleAnchorCallback(
    event({ eventId: "d1", kind: "disputed", ledgerVersion: 3, observedAt: T0 + 200 }),
  );

  const view = await h.reconciler.buildDisputeEvidence("USDC", "tx-1");
  assert.ok(view);
  assert.equal(view.anchor, "USDC");
  assert.equal(view.externalTxId, "tx-1");
  assert.equal(view.state, "DISPUTED");
  assert.equal(view.grossMinor, 10_000);
  assert.equal(view.netMinor, 9_700);
  assert.deepEqual(view.feeBreakdown, feeBreakdown);
  assert.equal(view.observedCallbacks.length, 3);
  assert.ok(view.observedCallbacks.every((c) => Number.isFinite(c.observedAt) && Number.isFinite(c.receivedAt)));
  assert.deepEqual(
    view.transitions.map((t) => t.toState),
    ["ANCHOR_CONFIRMED", "SETTLED", "DISPUTED"],
  );
  assert.ok(view.postingGroupId);
  assert.ok(view.postings.length >= 2, "ledger posting group present in evidence");
  assert.equal(view.proofHashes.length, view.postings.length);
  assert.ok(view.proofHashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  const posted = await h.ledgerStore.getGroup(view.postingGroupId!);
  assert.equal(validatePostingGroup(posted!).ok, true);

  const emitted = await h.reconciler.surfaceDispute("USDC", "tx-1");
  assert.ok(emitted);
  assert.equal(emitted.type, "dispute_surfaced");
  assert.equal(emitted.schema, "zv-010");
  assert.equal(emitted.version, 1);
  assert.equal(emitted.disputeId, "USDC:tx-1");
  assert.equal(emitted.evidence.observedCallbacks.length, 3);
  const logged = h.logEntries.find((entry) => entry.event === "dispute_surfaced");
  assert.ok(logged, "dispute_surfaced event must be logged for ZV-010 consumption");
  assert.equal((logged?.meta as { disputeId?: string }).disputeId, "USDC:tx-1");
});

test("dispute: post-settlement dispute escalates to DISPUTED, keeping the posting group", async () => {
  const h = makeHarness();
  await h.reconciler.handleAnchorCallback(
    event({ eventId: "s1", kind: "settled", ledgerVersion: 1, observedAt: T0, grossMinor: 5_000 }),
  );
  const escalated = await h.reconciler.handleAnchorCallback(
    event({ eventId: "d1", kind: "disputed", ledgerVersion: 2, observedAt: T0 + 50 }),
  );
  assert.equal(escalated.state, "DISPUTED");
  assert.equal(escalated.applied, true);
  assert.ok(escalated.record.postingGroupId, "posting group survives escalation");

  // Once DISPUTED, even a differently-idempotency-keyed settlement is a no-op.
  const lateSettled = await h.reconciler.handleAnchorCallback(
    event({ eventId: "s-late", kind: "settled", ledgerVersion: 3, observedAt: T0 + 60, grossMinor: 99_999 }),
  );
  assert.equal(lateSettled.reason, "terminal_noop");
  assert.equal(lateSettled.state, "DISPUTED");

  const emitted = await h.reconciler.surfaceDispute("USDC", "tx-1");
  assert.equal(emitted?.evidence.state, "DISPUTED");
  assert.ok(emitted?.evidence.postingGroupId);
  assert.ok(emitted?.evidence.proofHashes.length >= 2);
  assert.ok(emitted?.evidence.observedCallbacks.some((c) => c.kind === "disputed"));
});

test("aging: finds non-terminal records past thresholds and uses injected timers", async () => {
  const h = makeHarness();
  assert.equal(h.intervals.size, 0, "no timer may be started at construction");

  // A confirmed (non-terminal) record via a real callback.
  await h.reconciler.handleAnchorCallback(
    event({ eventId: "confirm-1", anchor: "USDC", externalTxId: "tx-confirmed", kind: "anchor_confirmed", ledgerVersion: 1, observedAt: T0, grossMinor: 1_000 }),
  );
  // A pending record inserted directly (PENDING is transient in normal flow).
  const pending: SettlementRecord = {
    key: "EURC:tx-pending",
    anchor: "EURC",
    externalTxId: "tx-pending",
    asset: "EURC",
    state: "PENDING",
    stateSince: T0,
    grossMinor: null,
    netMinor: null,
    feeBreakdown: [],
    postingGroupId: null,
    authority: null,
    createdAt: T0,
    updatedAt: T0,
    disputeSurfaced: false,
  };
  await h.store.putRecord(pending);
  // A terminal record that must never be reported.
  await h.reconciler.handleAnchorCallback(
    event({ eventId: "settle-2", anchor: "EURC", externalTxId: "tx-settled", kind: "settled", ledgerVersion: 1, observedAt: T0, grossMinor: 2_000 }),
  );

  const thresholds = { pendingMs: 10_000, anchorConfirmedMs: 5_000 };
  const now = T0 + 20_000;
  const items = await h.reconciler.findAgingUnsettled(now, thresholds);
  assert.deepEqual(items.map((i) => i.externalTxId).sort(), ["tx-confirmed", "tx-pending"]);
  assert.deepEqual(
    items.map((i) => i.thresholdMs).sort((a, b) => a - b),
    [5_000, 10_000],
  );
  assert.ok(items.every((i) => i.ageMs === 20_000));

  const seen: string[][] = [];
  const monitor = h.reconciler.startAgingMonitor({
    intervalMs: 1_000,
    thresholds,
    now: () => now,
    onAging: (found) => seen.push(found.map((i) => i.externalTxId)),
  });
  assert.equal(h.intervals.size, 1);
  assert.equal([...h.intervals.values()][0]?.ms, 1_000);
  for (const interval of h.intervals.values()) interval.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.sort(), ["tx-confirmed", "tx-pending"]);

  monitor.stop();
  assert.equal(h.intervals.size, 0, "stop() must clear the injected interval");
  assert.throws(() => h.reconciler.startAgingMonitor({ intervalMs: 0, onAging: () => {} }), /intervalMs/);
});
