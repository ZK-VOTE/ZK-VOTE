/**
 * Settlement reconciliation + callback state machine (refactor: registry /
 * settlement / voting composition).
 *
 * Anchor callbacks are chaotic by nature: they arrive more than once, out of
 * order, and sometimes carry conflicting authoritative data. This service
 * converges them onto a single terminal state per `(anchor, externalTxId)`:
 *
 *     PENDING -> ANCHOR_CONFIRMED -> SETTLED
 *                              \-> FAILED / DISPUTED
 *
 * Terminal states (SETTLED, FAILED, DISPUTED) are immutable except for the
 * explicit SETTLED -> DISPUTED escalation (a dispute raised after settlement
 * keeps its posting group). Late callbacks are recorded as evidence but never
 * revert state. Idempotency is two-layered:
 * event ids are unique (duplicate delivery is a no-op) and, for competing
 * callbacks that target the same state, the earliest authoritative event wins
 * (ordered by `(ledgerVersion, observedAt, eventId)`).
 *
 * Everything is injected. `createSettlementReconciliation(deps)` gives tests a
 * standalone instance with an in-memory store and a fake clock/timer port; the
 * module-level `initSettlementReconciliation(deps)` wires the default instance
 * used by the exported convenience functions (matching the repo's init* DI
 * convention). Nothing opens a DB or starts a timer on import.
 */

import crypto from "node:crypto";
import type { LoggerPort } from "./interfaces.js";
import { log as moduleLog } from "./logger.js";
import {
  buildTransferGroup,
  getDefaultLedgerStore,
  type LedgerPosting,
  type LedgerStore,
  validatePostingGroup,
} from "./ledger.js";

type MaybePromise<T> = T | Promise<T>;

// ===========================================================================
// State machine types
// ===========================================================================

export type SettlementState =
  | "PENDING"
  | "ANCHOR_CONFIRMED"
  | "SETTLED"
  | "FAILED"
  | "DISPUTED";

export type AnchorCallbackKind =
  | "anchor_confirmed"
  | "settled"
  | "failed"
  | "disputed";

export const TERMINAL_STATES: readonly SettlementState[] = [
  "SETTLED",
  "FAILED",
  "DISPUTED",
];

export function isTerminal(state: SettlementState): boolean {
  return TERMINAL_STATES.includes(state);
}

const ALLOWED_TRANSITIONS: Record<SettlementState, readonly SettlementState[]> = {
  PENDING: ["ANCHOR_CONFIRMED", "SETTLED", "FAILED", "DISPUTED"],
  ANCHOR_CONFIRMED: ["SETTLED", "FAILED", "DISPUTED"],
  // A dispute raised after settlement is a forward escalation, not a revert:
  // the existing posting group and all evidence are preserved. No other
  // terminal state has outgoing edges.
  SETTLED: ["DISPUTED"],
  FAILED: [],
  DISPUTED: [],
};

/** Return true when `from -> to` is a legal forward transition. */
export function canTransition(from: SettlementState, to: SettlementState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

const CALLBACK_TARGET: Record<AnchorCallbackKind, SettlementState> = {
  anchor_confirmed: "ANCHOR_CONFIRMED",
  settled: "SETTLED",
  failed: "FAILED",
  disputed: "DISPUTED",
};

/** Deterministic authority tuple — smaller == earlier / more authoritative. */
export interface EventAuthority {
  ledgerVersion: number;
  observedAt: number;
  eventId: string;
}

/**
 * Compare two authorities. Negative means `a` is strictly earlier/more
 * authoritative. Ledger version dominates observation time; event id is the
 * final deterministic tie-break so equal tuples never depend on arrival order.
 */
export function compareAuthority(a: EventAuthority, b: EventAuthority): number {
  const av = Number.isFinite(a.ledgerVersion) ? a.ledgerVersion : Number.MAX_SAFE_INTEGER;
  const bv = Number.isFinite(b.ledgerVersion) ? b.ledgerVersion : Number.MAX_SAFE_INTEGER;
  if (av !== bv) return av < bv ? -1 : 1;
  const at = Number.isFinite(a.observedAt) ? a.observedAt : Number.MAX_SAFE_INTEGER;
  const bt = Number.isFinite(b.observedAt) ? b.observedAt : Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

/** Canonical idempotency key for one external transaction at one anchor. */
export function settlementKey(anchor: string, externalTxId: string): string {
  return `${anchor}:${externalTxId}`;
}

// ===========================================================================
// Fee reconciliation (integer minor units, pure)
// ===========================================================================

export interface FeeLine {
  code: string;
  amountMinor: number;
}

export type FeeBreakdownInput = readonly FeeLine[] | Readonly<Record<string, number>>;

export interface ReconcileFeesInput {
  /** Gross amount in integer minor units. */
  gross: number;
  /** Observed settled/net amount (also accepted as `settled`). */
  net?: number;
  settled?: number;
  feeBreakdown: FeeBreakdownInput;
}

export interface FeeReconciliation {
  grossMinor: number;
  netMinor: number;
  feesMinor: number;
  breakdown: FeeLine[];
}

function assertMinor(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer (minor units)`);
  }
}

/** Normalize array / object fee breakdowns into labelled integer lines. */
export function normalizeFeeBreakdown(input?: FeeBreakdownInput): FeeLine[] {
  if (input === undefined || input === null) return [];
  if (Array.isArray(input)) {
    return input.map((entry, index) => {
      if (typeof entry === "number") return { code: `fee_${index}`, amountMinor: entry };
      return {
        code: String(entry?.code ?? `fee_${index}`),
        amountMinor: Number(entry?.amountMinor ?? (entry as unknown as { amount?: number })?.amount),
      };
    });
  }
  return Object.entries(input).map(([code, amount]) => ({
    code,
    amountMinor: Number(amount),
  }));
}

/**
 * Reconcile a fee breakdown against the settled amount exactly.
 *
 * Invariant: `sum(fees) === gross - net`, computed with integer minor units so
 * there is no float drift. When `net`/`settled` is omitted the net is derived
 * from gross minus fees (still integer-exact); callers that know the actual
 * settled amount should pass it so a mismatching breakdown throws.
 */
export function reconcileFees(input: ReconcileFeesInput): FeeReconciliation {
  assertMinor(input.gross, "gross");
  const breakdown = normalizeFeeBreakdown(input.feeBreakdown);
  let feesMinor = 0;
  for (const fee of breakdown) {
    assertMinor(fee.amountMinor, `feeBreakdown.${fee.code}`);
    feesMinor += fee.amountMinor;
    if (!Number.isSafeInteger(feesMinor)) throw new Error("fee breakdown overflow");
  }
  const derivedNet = input.gross - feesMinor;
  if (!Number.isSafeInteger(derivedNet) || derivedNet < 0) {
    throw new Error("fee breakdown exceeds gross amount");
  }
  const observedNet = input.net ?? input.settled;
  if (observedNet !== undefined) {
    assertMinor(observedNet, "net");
    if (feesMinor !== input.gross - observedNet) {
      throw new Error(
        `fee breakdown does not reconcile: sum(fees)=${feesMinor}, gross-net=${input.gross - observedNet}`,
      );
    }
  }
  return {
    grossMinor: input.gross,
    netMinor: observedNet ?? derivedNet,
    feesMinor,
    breakdown,
  };
}

// ===========================================================================
// Records, callbacks, transitions
// ===========================================================================

export interface CallbackEventInput {
  eventId: string;
  anchor: string;
  externalTxId: string;
  kind: AnchorCallbackKind;
  asset?: string;
  grossMinor?: number;
  netMinor?: number;
  feeBreakdown?: FeeBreakdownInput;
  ledgerVersion: number;
  observedAt: number;
  payload?: Record<string, unknown>;
}

export interface AnchorCallbackEvent extends CallbackEventInput {
  payload?: Record<string, unknown>;
}

export interface ObservedCallback extends AnchorCallbackEvent {
  receivedAt: number;
}

export interface SettlementRecord {
  key: string;
  anchor: string;
  externalTxId: string;
  asset: string;
  state: SettlementState;
  /** Timestamp at which the current state was entered. */
  stateSince: number;
  grossMinor: number | null;
  netMinor: number | null;
  feeBreakdown: FeeLine[];
  postingGroupId: string | null;
  authority: EventAuthority | null;
  createdAt: number;
  updatedAt: number;
  disputeSurfaced: boolean;
}

export interface SettlementTransition {
  id: string;
  key: string;
  anchor: string;
  externalTxId: string;
  fromState: SettlementState;
  toState: SettlementState;
  reason: "callback" | "out_of_order_settled" | "conflict_earlier_authority";
  eventId: string;
  ledgerVersion: number;
  observedAt: number;
  createdAt: number;
}

export interface SettlementStore {
  getRecord(key: string): MaybePromise<SettlementRecord | undefined>;
  putRecord(record: SettlementRecord): MaybePromise<void>;
  getCallback(eventId: string): MaybePromise<ObservedCallback | undefined>;
  putCallback(callback: ObservedCallback): MaybePromise<void>;
  listCallbacks(key: string): MaybePromise<ObservedCallback[]>;
  listTransitions(key: string): MaybePromise<SettlementTransition[]>;
  appendTransition(transition: SettlementTransition): MaybePromise<void>;
  listRecords(): MaybePromise<SettlementRecord[]>;
}

/** In-memory store used by the chaos tests and as a zero-dependency default. */
export interface InMemorySettlementStore extends SettlementStore {
  records: Map<string, SettlementRecord>;
  callbacks: Map<string, ObservedCallback>;
  transitions: Map<string, SettlementTransition[]>;
}

export function createInMemorySettlementStore(): InMemorySettlementStore {
  const records = new Map<string, SettlementRecord>();
  const callbacks = new Map<string, ObservedCallback>();
  const transitions = new Map<string, SettlementTransition[]>();
  const clone = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  return {
    records,
    callbacks,
    transitions,
    getRecord: (key) => clone(records.get(key) as SettlementRecord),
    putRecord: (record) => {
      records.set(record.key, clone(record));
    },
    getCallback: (eventId) => clone(callbacks.get(eventId) as ObservedCallback),
    putCallback: (callback) => {
      callbacks.set(callback.eventId, clone(callback));
    },
    listCallbacks: (key) =>
      [...callbacks.values()].filter((c) => settlementKey(c.anchor, c.externalTxId) === key).map(clone),
    listTransitions: (key) => (transitions.get(key) ?? []).map(clone),
    appendTransition: (transition) => {
      const list = transitions.get(transition.key) ?? [];
      list.push(clone(transition));
      transitions.set(transition.key, list);
    },
    listRecords: () => [...records.values()].map(clone),
  };
}

// Defensive SQLite DDL — mirrors migration 014 exactly; making the store able
// to bootstrap itself keeps unit tests independent of the migration runner.
const SETTLEMENT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS settlement_records (
    key TEXT PRIMARY KEY,
    anchor TEXT NOT NULL,
    external_tx_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    state TEXT NOT NULL,
    state_since INTEGER NOT NULL,
    gross_minor INTEGER,
    net_minor INTEGER,
    fee_breakdown TEXT NOT NULL DEFAULT '[]',
    posting_group_id TEXT,
    authority TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    dispute_surfaced INTEGER NOT NULL DEFAULT 0,
    UNIQUE(anchor, external_tx_id)
  );
  CREATE INDEX IF NOT EXISTS idx_settlement_records_state ON settlement_records(state, state_since);
  CREATE TABLE IF NOT EXISTS settlement_callbacks (
    event_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    anchor TEXT NOT NULL,
    external_tx_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ledger_version INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    asset TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    gross_minor INTEGER,
    net_minor INTEGER,
    fee_breakdown TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_settlement_callbacks_key ON settlement_callbacks(key);
  CREATE TABLE IF NOT EXISTS settlement_transitions (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    anchor TEXT NOT NULL,
    external_tx_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    event_id TEXT NOT NULL,
    ledger_version INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_settlement_transitions_key ON settlement_transitions(key);
`;

interface SqliteStatementPort {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface SqliteDbPort {
  prepare(sql: string): SqliteStatementPort;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface RecordRow {
  key: string;
  anchor: string;
  external_tx_id: string;
  asset: string;
  state: SettlementState;
  state_since: number;
  gross_minor: number | null;
  net_minor: number | null;
  fee_breakdown: string;
  posting_group_id: string | null;
  authority: string | null;
  created_at: number;
  updated_at: number;
  dispute_surfaced: number;
}
interface CallbackRow {
  event_id: string;
  key: string;
  anchor: string;
  external_tx_id: string;
  kind: AnchorCallbackKind;
  ledger_version: number;
  observed_at: number;
  received_at: number;
  asset: string | null;
  payload: string;
  gross_minor: number | null;
  net_minor: number | null;
  fee_breakdown: string;
}
interface TransitionRow {
  id: string;
  key: string;
  anchor: string;
  external_tx_id: string;
  from_state: SettlementState;
  to_state: SettlementState;
  reason: SettlementTransition["reason"];
  event_id: string;
  ledger_version: number;
  observed_at: number;
  created_at: number;
}

/** SQLite persistence for reconciliation state (composition root supplies the db). */
export function createSqliteSettlementStore(db: SqliteDbPort): SettlementStore {
  for (const statement of SETTLEMENT_TABLE_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    db.prepare(statement).run();
  }
  return {
    getRecord(key) {
      const row = db.prepare("SELECT * FROM settlement_records WHERE key = ?").get(key) as RecordRow | undefined;
      if (!row) return undefined;
      return {
        key: row.key,
        anchor: row.anchor,
        externalTxId: row.external_tx_id,
        asset: row.asset,
        state: row.state,
        stateSince: row.state_since,
        grossMinor: row.gross_minor,
        netMinor: row.net_minor,
        feeBreakdown: parseJson<FeeLine[]>(row.fee_breakdown, []),
        postingGroupId: row.posting_group_id,
        authority: parseJson<EventAuthority | null>(row.authority, null),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        disputeSurfaced: Boolean(row.dispute_surfaced),
      };
    },
    putRecord(record) {
      db.prepare(
        `INSERT OR REPLACE INTO settlement_records
          (key, anchor, external_tx_id, asset, state, state_since, gross_minor, net_minor,
           fee_breakdown, posting_group_id, authority, created_at, updated_at, dispute_surfaced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.key,
        record.anchor,
        record.externalTxId,
        record.asset,
        record.state,
        record.stateSince,
        record.grossMinor,
        record.netMinor,
        JSON.stringify(record.feeBreakdown ?? []),
        record.postingGroupId,
        record.authority ? JSON.stringify(record.authority) : null,
        record.createdAt,
        record.updatedAt,
        record.disputeSurfaced ? 1 : 0,
      );
    },
    getCallback(eventId) {
      const row = db.prepare("SELECT * FROM settlement_callbacks WHERE event_id = ?").get(eventId) as CallbackRow | undefined;
      if (!row) return undefined;
      return {
        eventId: row.event_id,
        key: row.key,
        anchor: row.anchor,
        externalTxId: row.external_tx_id,
        kind: row.kind,
        ledgerVersion: row.ledger_version,
        observedAt: row.observed_at,
        receivedAt: row.received_at,
        asset: row.asset ?? undefined,
        grossMinor: row.gross_minor ?? undefined,
        netMinor: row.net_minor ?? undefined,
        feeBreakdown: parseJson<FeeLine[]>(row.fee_breakdown, []),
        payload: parseJson<Record<string, unknown>>(row.payload, {}),
      };
    },
    putCallback(callback) {
      db.prepare(
        `INSERT OR REPLACE INTO settlement_callbacks
          (event_id, key, anchor, external_tx_id, kind, ledger_version, observed_at,
           received_at, asset, payload, gross_minor, net_minor, fee_breakdown)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        callback.eventId,
        settlementKey(callback.anchor, callback.externalTxId),
        callback.anchor,
        callback.externalTxId,
        callback.kind,
        callback.ledgerVersion,
        callback.observedAt,
        callback.receivedAt,
        callback.asset ?? null,
        JSON.stringify(callback.payload ?? {}),
        callback.grossMinor ?? null,
        callback.netMinor ?? null,
        JSON.stringify(callback.feeBreakdown ?? []),
      );
    },
    listCallbacks(key) {
      const rows = db.prepare("SELECT * FROM settlement_callbacks WHERE key = ? ORDER BY observed_at, event_id").all(key) as CallbackRow[];
      return rows.map((row) => ({
        eventId: row.event_id,
        key: row.key,
        anchor: row.anchor,
        externalTxId: row.external_tx_id,
        kind: row.kind,
        ledgerVersion: row.ledger_version,
        observedAt: row.observed_at,
        receivedAt: row.received_at,
        asset: row.asset ?? undefined,
        grossMinor: row.gross_minor ?? undefined,
        netMinor: row.net_minor ?? undefined,
        feeBreakdown: parseJson<FeeLine[]>(row.fee_breakdown, []),
        payload: parseJson<Record<string, unknown>>(row.payload, {}),
      }));
    },
    listTransitions(key) {
      const rows = db.prepare("SELECT * FROM settlement_transitions WHERE key = ? ORDER BY observed_at, id").all(key) as TransitionRow[];
      return rows.map((row) => ({
        id: row.id,
        key: row.key,
        anchor: row.anchor,
        externalTxId: row.external_tx_id,
        fromState: row.from_state,
        toState: row.to_state,
        reason: row.reason,
        eventId: row.event_id,
        ledgerVersion: row.ledger_version,
        observedAt: row.observed_at,
        createdAt: row.created_at,
      }));
    },
    appendTransition(transition) {
      db.prepare(
        `INSERT OR REPLACE INTO settlement_transitions
          (id, key, anchor, external_tx_id, from_state, to_state, reason, event_id, ledger_version, observed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        transition.id,
        transition.key,
        transition.anchor,
        transition.externalTxId,
        transition.fromState,
        transition.toState,
        transition.reason,
        transition.eventId,
        transition.ledgerVersion,
        transition.observedAt,
        transition.createdAt,
      );
    },
    listRecords() {
      const rows = db.prepare("SELECT * FROM settlement_records").all() as RecordRow[];
      return rows.map((row) => ({
        key: row.key,
        anchor: row.anchor,
        externalTxId: row.external_tx_id,
        asset: row.asset,
        state: row.state,
        stateSince: row.state_since,
        grossMinor: row.gross_minor,
        netMinor: row.net_minor,
        feeBreakdown: parseJson<FeeLine[]>(row.fee_breakdown, []),
        postingGroupId: row.posting_group_id,
        authority: parseJson<EventAuthority | null>(row.authority, null),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        disputeSurfaced: Boolean(row.dispute_surfaced),
      }));
    },
  };
}

// ===========================================================================
// Dispute evidence (ZV-010 consumable)
// ===========================================================================

/** Complete, self-contained evidence bundle for a disputed settlement. */
export interface DisputeView {
  anchor: string;
  externalTxId: string;
  key: string;
  state: SettlementState;
  asset: string;
  grossMinor: number | null;
  netMinor: number | null;
  feeBreakdown: FeeLine[];
  /** All observed anchor callbacks, with both anchor and receipt timestamps. */
  observedCallbacks: ObservedCallback[];
  /** Every state transition, including no-op conflict resolutions. */
  transitions: SettlementTransition[];
  postingGroupId: string | null;
  postings: LedgerPosting[];
  /** Non-empty SHA-256 proofs, one per posting. */
  proofHashes: string[];
  builtAt: number;
}

/** Event envelope emitted for ZV-010 dispute consumers. */
export interface DisputeSurfacedEvent {
  type: "dispute_surfaced";
  schema: "zv-010";
  version: 1;
  disputeId: string;
  emittedAt: string;
  evidence: DisputeView;
}

// ===========================================================================
// Aging monitor types
// ===========================================================================

export interface AgingThresholds {
  pendingMs?: number;
  anchorConfirmedMs?: number;
  defaultMs?: number;
}

export interface AgingItem {
  key: string;
  anchor: string;
  externalTxId: string;
  state: SettlementState;
  stateSince: number;
  ageMs: number;
  thresholdMs: number;
}

export interface TimersPort {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Real timers, used only when a monitor is explicitly started. */
export const systemTimers: TimersPort = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface AgingMonitorOptions {
  intervalMs: number;
  thresholds?: AgingThresholds;
  now?: () => number;
  onAging: (items: AgingItem[]) => void | Promise<void>;
  immediate?: boolean;
}

export interface AgingMonitorHandle {
  tick(): Promise<AgingItem[]>;
  stop(): void;
}

// ===========================================================================
// Reconciler
// ===========================================================================

export interface SettlementReconciliationDeps {
  store: SettlementStore;
  ledgerStore: LedgerStore;
  logger: LoggerPort;
  /** Injectable clock (deterministic tests). */
  now?: () => number;
  /** Required only for `startAgingMonitor`. No timer is created otherwise. */
  timers?: TimersPort;
}

export interface CallbackResult {
  state: SettlementState;
  applied: boolean;
  reason:
    | "applied"
    | "duplicate"
    | "terminal_noop"
    | "conflict_later"
    | "conflict_earlier_authority"
    | "invalid_transition";
  record: SettlementRecord;
}

function assertCallbackEvent(event: AnchorCallbackEvent): void {
  if (!event || typeof event !== "object") throw new Error("callback event must be an object");
  if (!event.eventId || typeof event.eventId !== "string") throw new Error("callback eventId is required");
  if (!event.anchor || typeof event.anchor !== "string") throw new Error("callback anchor is required");
  if (!event.externalTxId || typeof event.externalTxId !== "string") throw new Error("callback externalTxId is required");
  if (!(event.kind in CALLBACK_TARGET)) throw new Error(`unknown callback kind: ${String(event.kind)}`);
  if (!Number.isFinite(event.ledgerVersion)) throw new Error("callback ledgerVersion must be finite");
  if (!Number.isFinite(event.observedAt)) throw new Error("callback observedAt must be finite");
  if (event.grossMinor !== undefined) assertMinor(event.grossMinor, "grossMinor");
  if (event.netMinor !== undefined) assertMinor(event.netMinor, "netMinor");
}

export class SettlementReconciler {
  constructor(private readonly deps: SettlementReconciliationDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get store(): SettlementStore {
    return this.deps.store;
  }

  private get logger(): LoggerPort {
    return this.deps.logger;
  }

  /** Ingest one anchor callback; idempotent and order-independent. */
  async handleAnchorCallback(event: AnchorCallbackEvent): Promise<CallbackResult> {
    assertCallbackEvent(event);

    // Layer 1: unique event id — a redelivered callback is a pure no-op.
    const duplicate = await this.store.getCallback(event.eventId);
    if (duplicate) {
      const existing = await this.store.getRecord(
        settlementKey(duplicate.anchor, duplicate.externalTxId),
      );
      return {
        state: existing?.state ?? "PENDING",
        applied: false,
        reason: "duplicate",
        record:
          existing ??
          ({
            key: settlementKey(event.anchor, event.externalTxId),
            anchor: event.anchor,
            externalTxId: event.externalTxId,
            state: "PENDING",
          } as SettlementRecord),
      };
    }

    const key = settlementKey(event.anchor, event.externalTxId);
    const now = this.now();
    let record = await this.store.getRecord(key);
    if (!record) {
      record = {
        key,
        anchor: event.anchor,
        externalTxId: event.externalTxId,
        asset: event.asset ?? "USDC",
        state: "PENDING",
        stateSince: event.observedAt,
        grossMinor: event.grossMinor ?? null,
        netMinor: event.netMinor ?? null,
        feeBreakdown: normalizeFeeBreakdown(event.feeBreakdown),
        postingGroupId: null,
        authority: null,
        createdAt: now,
        updatedAt: now,
        disputeSurfaced: false,
      };
      await this.store.putRecord(record);
    }

    // Even a no-op callback is preserved as evidence for dispute bundles.
    await this.store.putCallback({ ...event, receivedAt: now });

    const target = CALLBACK_TARGET[event.kind];
    const incoming: EventAuthority = {
      ledgerVersion: event.ledgerVersion,
      observedAt: event.observedAt,
      eventId: event.eventId,
    };

    // Terminal states are immutable except for the explicit SETTLED -> DISPUTED
    // escalation. Out-of-order callbacks (a late confirmation, a second
    // settlement, a failed event) can never revert them.
    if (isTerminal(record.state) && !canTransition(record.state, target)) {
      this.logger.info("settlement_callback_terminal_noop", {
        key,
        eventId: event.eventId,
        kind: event.kind,
        state: record.state,
      });
      return { state: record.state, applied: false, reason: "terminal_noop", record };
    }

    // Layer 2: competing callbacks for the *same* state. The earliest
    // authoritative one wins; later duplicates do not even rewrite metadata.
    if (target === record.state) {
      if (record.authority && compareAuthority(incoming, record.authority) >= 0) {
        return { state: record.state, applied: false, reason: "conflict_later", record };
      }
      record.authority = incoming;
      if (event.asset) record.asset = event.asset;
      if (event.grossMinor !== undefined) record.grossMinor = event.grossMinor;
      if (event.netMinor !== undefined) record.netMinor = event.netMinor;
      if (event.feeBreakdown !== undefined) record.feeBreakdown = normalizeFeeBreakdown(event.feeBreakdown);
      record.updatedAt = now;
      await this.store.putRecord(record);
      await this.store.appendTransition({
        id: `${event.eventId}:conflict`,
        key,
        anchor: event.anchor,
        externalTxId: event.externalTxId,
        fromState: record.state,
        toState: record.state,
        reason: "conflict_earlier_authority",
        eventId: event.eventId,
        ledgerVersion: event.ledgerVersion,
        observedAt: event.observedAt,
        createdAt: now,
      });
      return { state: record.state, applied: true, reason: "conflict_earlier_authority", record };
    }

    if (!canTransition(record.state, target)) {
      return { state: record.state, applied: false, reason: "invalid_transition", record };
    }

    const fromState = record.state;
    record.state = target;
    record.stateSince = event.observedAt;
    record.authority = incoming;
    record.updatedAt = now;
    if (event.asset) record.asset = event.asset;
    if (event.grossMinor !== undefined) record.grossMinor = event.grossMinor;
    if (event.netMinor !== undefined) record.netMinor = event.netMinor;
    if (event.feeBreakdown !== undefined) record.feeBreakdown = normalizeFeeBreakdown(event.feeBreakdown);

    if (target === "SETTLED") {
      await this.postSettlementLedger(record);
    }

    await this.store.putRecord(record);
    await this.store.appendTransition({
      id: `${event.eventId}:${fromState}->${target}`,
      key,
      anchor: event.anchor,
      externalTxId: event.externalTxId,
      fromState,
      toState: target,
      // A SETTLED callback can legally jump PENDING -> SETTLED (out of order).
      reason: fromState === "PENDING" && target === "SETTLED" ? "out_of_order_settled" : "callback",
      eventId: event.eventId,
      ledgerVersion: event.ledgerVersion,
      observedAt: event.observedAt,
      createdAt: now,
    });
    this.logger.info("settlement_state_transition", {
      key,
      fromState,
      toState: target,
      eventId: event.eventId,
      postingGroupId: record.postingGroupId,
    });
    return { state: target, applied: true, reason: "applied", record };
  }

  /** Post one balanced, fee-aware ledger group when a settlement finalizes. */
  private async postSettlementLedger(record: SettlementRecord): Promise<void> {
    if (record.postingGroupId) return; // never double-post a settlement
    const gross = record.grossMinor;
    if (gross === null || !Number.isSafeInteger(gross) || gross < 0) {
      throw new Error("SETTLED callback is missing a valid grossMinor");
    }
    const fees = reconcileFees({
      gross,
      net: record.netMinor ?? undefined,
      feeBreakdown: record.feeBreakdown,
    });
    const group = buildTransferGroup({
      postingGroupId: `settle_${record.key}_${record.authority?.eventId ?? crypto.randomUUID()}`,
      sourceAccount: `anchor:${record.anchor}:clearing`,
      destinationAccount: `settlement:${record.externalTxId}`,
      asset: record.asset,
      amountMinor: gross,
      feeLegs: fees.breakdown.map((fee) => ({ account: `fee:${fee.code}`, amountMinor: fee.amountMinor })),
      createdAt: new Date(this.now()).toISOString(),
    });
    const validation = validatePostingGroup(group);
    if (!validation.ok) throw new Error(`settlement posting not balanced: ${validation.errors.join("; ")}`);
    await this.deps.ledgerStore.saveGroup(group);
    record.postingGroupId = group.postingGroupId;
    record.netMinor = fees.netMinor;
    record.feeBreakdown = fees.breakdown;
  }

  /** Current persisted state for one external transaction (null when unknown). */
  async getRecord(anchor: string, externalTxId: string): Promise<SettlementRecord | null> {
    return (await this.store.getRecord(settlementKey(anchor, externalTxId))) ?? null;
  }

  /** Verify the posting group tied to a settlement still balances. */
  async validateSettlementPostings(
    anchor: string,
    externalTxId: string,
  ): Promise<{ ok: boolean; errors: string[] }> {
    const record = await this.getRecord(anchor, externalTxId);
    if (!record?.postingGroupId) {
      return { ok: false, errors: ["no posting group for settlement"] };
    }
    const group = await this.deps.ledgerStore.getGroup(record.postingGroupId);
    if (!group) return { ok: false, errors: ["posting group not found"] };
    return validatePostingGroup(group);
  }

  /** Complete evidence bundle for ZV-010 (null when the tx is unknown). */
  async buildDisputeEvidence(anchor: string, externalTxId: string): Promise<DisputeView | null> {
    const key = settlementKey(anchor, externalTxId);
    const record = await this.store.getRecord(key);
    if (!record) return null;
    const callbacks = (await this.store.listCallbacks(key)).sort(
      (a, b) => a.observedAt - b.observedAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
    );
    const transitions = (await this.store.listTransitions(key)).sort(
      (a, b) => a.observedAt - b.observedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    let postings: LedgerPosting[] = [];
    if (record.postingGroupId) {
      const group = await this.deps.ledgerStore.getGroup(record.postingGroupId);
      postings = group?.postings ?? [];
    }
    return {
      anchor: record.anchor,
      externalTxId: record.externalTxId,
      key,
      state: record.state,
      asset: record.asset,
      grossMinor: record.grossMinor,
      netMinor: record.netMinor,
      feeBreakdown: record.feeBreakdown,
      observedCallbacks: callbacks,
      transitions,
      postingGroupId: record.postingGroupId,
      postings,
      proofHashes: postings.map((p) => p.balanceProofHash),
      builtAt: this.now(),
    };
  }

  /** Build + emit a `dispute_surfaced` event; returns the ZV-010 envelope. */
  async surfaceDispute(anchor: string, externalTxId: string): Promise<DisputeSurfacedEvent | null> {
    const evidence = await this.buildDisputeEvidence(anchor, externalTxId);
    if (!evidence) return null;
    const event: DisputeSurfacedEvent = {
      type: "dispute_surfaced",
      schema: "zv-010",
      version: 1,
      disputeId: evidence.key,
      emittedAt: new Date(this.now()).toISOString(),
      evidence,
    };
    this.logger.warn("dispute_surfaced", {
      disputeId: event.disputeId,
      anchor: evidence.anchor,
      externalTxId: evidence.externalTxId,
      event,
    });
    const key = settlementKey(anchor, externalTxId);
    const record = await this.store.getRecord(key);
    if (record && !record.disputeSurfaced) {
      record.disputeSurfaced = true;
      record.updatedAt = this.now();
      await this.store.putRecord(record);
    }
    return event;
  }

  /** Non-terminal records that have been in their current state too long. */
  async findAgingUnsettled(now: number, thresholds: AgingThresholds = {}): Promise<AgingItem[]> {
    if (!Number.isFinite(now)) throw new Error("now must be a finite timestamp");
    const pendingMs = thresholds.pendingMs ?? 24 * 60 * 60 * 1000;
    const confirmedMs = thresholds.anchorConfirmedMs ?? 60 * 60 * 1000;
    const defaultMs = thresholds.defaultMs ?? pendingMs;
    const records = await this.store.listRecords();
    const items: AgingItem[] = [];
    for (const record of records) {
      if (isTerminal(record.state)) continue;
      const thresholdMs =
        record.state === "PENDING" ? pendingMs : record.state === "ANCHOR_CONFIRMED" ? confirmedMs : defaultMs;
      const ageMs = now - record.stateSince;
      if (ageMs >= thresholdMs) {
        items.push({
          key: record.key,
          anchor: record.anchor,
          externalTxId: record.externalTxId,
          state: record.state,
          stateSince: record.stateSince,
          ageMs,
          thresholdMs,
        });
      }
    }
    return items.sort((a, b) => b.ageMs - a.ageMs);
  }

  /**
   * Start an aging monitor. The interval implementation MUST be injected via
   * `deps.timers` (or options); nothing is scheduled at import time, and the
   * returned handle always clears the interval via `stop()`.
   */
  startAgingMonitor(options: AgingMonitorOptions): AgingMonitorHandle {
    const timers = this.deps.timers;
    if (!timers) {
      throw new Error("settlementReconciliation: timers port required for startAgingMonitor");
    }
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("intervalMs must be a positive finite number");
    }
    let stopped = false;
    const tick = async (): Promise<AgingItem[]> => {
      const now = options.now?.() ?? this.now();
      const items = await this.findAgingUnsettled(now, options.thresholds);
      if (items.length > 0) await options.onAging(items);
      return items;
    };
    const onError = (error: unknown): void => {
      this.logger.error("aging_monitor_tick_failed", { error: (error as Error).message });
    };
    const handle = timers.setInterval(() => {
      void tick().catch(onError);
    }, options.intervalMs);
    if (options.immediate) void tick().catch(onError);
    return {
      tick,
      stop: () => {
        if (stopped) return;
        stopped = true;
        timers.clearInterval(handle);
      },
    };
  }
}

// ===========================================================================
// Factory + module-level init* convenience layer
// ===========================================================================

export function createSettlementReconciliation(
  deps: SettlementReconciliationDeps,
): SettlementReconciler {
  return new SettlementReconciler(deps);
}

const fallbackLogger: LoggerPort = {
  debug: (event, meta) => moduleLog("debug", event, meta),
  info: (event, meta) => moduleLog("info", event, meta),
  warn: (event, meta) => moduleLog("warn", event, meta),
  error: (event, meta) => moduleLog("error", event, meta),
  log: (level, event, meta) => moduleLog(level, event, meta),
};

let defaultReconciler: SettlementReconciler | undefined;
let moduleMonitor: AgingMonitorHandle | undefined;

/** Wire the default reconciler (composition root / tests). */
export function initSettlementReconciliation(deps: SettlementReconciliationDeps): void {
  if (moduleMonitor) {
    moduleMonitor.stop();
    moduleMonitor = undefined;
  }
  defaultReconciler = createSettlementReconciliation(deps);
}

function reconciler(): SettlementReconciler {
  if (!defaultReconciler) {
    defaultReconciler = createSettlementReconciliation({
      store: createInMemorySettlementStore(),
      ledgerStore: getDefaultLedgerStore(),
      logger: fallbackLogger,
      timers: systemTimers,
    });
  }
  return defaultReconciler;
}

export function handleAnchorCallback(event: AnchorCallbackEvent): Promise<CallbackResult> {
  return reconciler().handleAnchorCallback(event);
}
export function getSettlementState(anchor: string, externalTxId: string): Promise<SettlementRecord | null> {
  return reconciler().getRecord(anchor, externalTxId);
}
export function buildDisputeEvidence(anchor: string, externalTxId: string): Promise<DisputeView | null> {
  return reconciler().buildDisputeEvidence(anchor, externalTxId);
}
export function surfaceDispute(anchor: string, externalTxId: string): Promise<DisputeSurfacedEvent | null> {
  return reconciler().surfaceDispute(anchor, externalTxId);
}
export function findAgingUnsettled(now: number, thresholds?: AgingThresholds): Promise<AgingItem[]> {
  return reconciler().findAgingUnsettled(now, thresholds);
}
export function startAgingMonitor(options: AgingMonitorOptions): AgingMonitorHandle {
  if (moduleMonitor) moduleMonitor.stop();
  moduleMonitor = reconciler().startAgingMonitor(options);
  return moduleMonitor;
}
export function stopAgingMonitor(): void {
  moduleMonitor?.stop();
  moduleMonitor = undefined;
}
