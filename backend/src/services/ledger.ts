/**
 * Double-entry settlement ledger (refactor: registry / settlement / voting composition).
 *
 * Design invariants (enforced here, not merely documented):
 *   - Every posting group balances: sum(DEBIT) === sum(CREDIT), per asset.
 *   - Every entry carries a non-empty, deterministic `balanceProofHash`:
 *       SHA-256(JSON.stringify([postingGroupId, account, asset, amount, direction, sequence]))
 *     so a tampered amount/account/direction/sequence invalidates the hash.
 *   - All money is integer *minor units* (no floating-point arithmetic).
 *
 * Storage is injected (`LedgerStore`): an in-memory implementation is provided
 * for unit tests and a SQLite implementation for production. The module-level
 * helpers are a thin convenience layer over an injected default store; they
 * never open a database or start a timer on import.
 */

import crypto from "node:crypto";
import type { LoggerPort } from "./interfaces.js";
import { log as moduleLog } from "./logger.js";

export type LedgerDirection = "DEBIT" | "CREDIT";

/** One side of a double-entry posting. Amounts are integer minor units. */
export interface LedgerLeg {
  account: string;
  asset: string;
  amountMinor: number;
  direction: LedgerDirection;
}

/** A persisted, hashed entry inside a posting group. */
export interface LedgerPosting extends LedgerLeg {
  postingId: string;
  postingGroupId: string;
  sequence: number;
  balanceProofHash: string;
  createdAt: string;
}

/** A balanced set of entries sharing one `postingGroupId`. */
export interface PostingGroup {
  postingGroupId: string;
  asset: string;
  postings: LedgerPosting[];
  createdAt: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// ===========================================================================
// Canonical serialization + hashing (pure)
// ===========================================================================

/** Canonical, delimiter-injection-safe serialization of a posting's identity. */
export function canonicalPosting(
  p: Pick<
    LedgerPosting,
    "postingGroupId" | "account" | "asset" | "amountMinor" | "direction" | "sequence"
  >,
): string {
  return JSON.stringify([
    p.postingGroupId,
    p.account,
    p.asset,
    p.amountMinor,
    p.direction,
    p.sequence,
  ]);
}

/** Deterministic SHA-256 balance proof over the canonical posting. */
export function computeBalanceProofHash(
  p: Parameters<typeof canonicalPosting>[0],
): string {
  return crypto.createHash("sha256").update(canonicalPosting(p)).digest("hex");
}

/** Deterministic id for an entry; derived from the same canonical tuple. */
export function computePostingId(p: Parameters<typeof canonicalPosting>[0]): string {
  return crypto
    .createHash("sha256")
    .update(`${canonicalPosting(p)}#posting-id`)
    .digest("hex");
}

/** Assert an integer minor-unit amount (no floats, no NaN, no negatives). */
export function assertMinorAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer (minor units)`);
  }
}

// Deterministic ordering: DEBIT before CREDIT, then account, amount, asset.
// Sequence assignment must not depend on caller-supplied leg order.
const DIRECTION_ORDER: Record<LedgerDirection, number> = { DEBIT: 0, CREDIT: 1 };

function compareLegs(a: LedgerLeg, b: LedgerLeg): number {
  const d = DIRECTION_ORDER[a.direction] - DIRECTION_ORDER[b.direction];
  if (d !== 0) return d;
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  if (a.amountMinor !== b.amountMinor) return a.amountMinor - b.amountMinor;
  if (a.asset !== b.asset) return a.asset < b.asset ? -1 : 1;
  return 0;
}

// ===========================================================================
// Build + validate (pure)
// ===========================================================================

export interface BuildPostingGroupInput {
  postingGroupId?: string;
  legs: readonly LedgerLeg[];
  /** If supplied, every leg must use this asset. */
  asset?: string;
  createdAt?: string;
}

/**
 * Build a balanced, hashed posting group. Throws on imbalance, zero amounts,
 * mixed assets, non-integer amounts or empty accounts.
 */
export function buildBalancedPostingGroup(
  input: BuildPostingGroupInput,
): PostingGroup {
  const legs = input.legs;
  if (!Array.isArray(legs) || legs.length < 2) {
    throw new Error("posting group needs at least two entries (a pair)");
  }
  const postingGroupId = input.postingGroupId ?? crypto.randomUUID();
  if (typeof postingGroupId !== "string" || postingGroupId.length === 0) {
    throw new Error("postingGroupId must be a non-empty string");
  }

  const assets = new Set<string>();
  for (const leg of legs) {
    if (!leg || typeof leg.account !== "string" || leg.account.length === 0) {
      throw new Error("every posting entry needs a non-empty account");
    }
    if (typeof leg.asset !== "string" || leg.asset.length === 0) {
      throw new Error("every posting entry needs a non-empty asset");
    }
    if (!Number.isSafeInteger(leg.amountMinor) || leg.amountMinor <= 0) {
      throw new Error("posting amounts must be positive safe integers (minor units)");
    }
    if (leg.direction !== "DEBIT" && leg.direction !== "CREDIT") {
      throw new Error(`invalid posting direction: ${String(leg.direction)}`);
    }
    assets.add(leg.asset);
  }
  if (assets.size !== 1) {
    throw new Error("a posting group must contain exactly one asset");
  }
  const asset = [...assets][0] as string;
  if (input.asset !== undefined && input.asset !== asset) {
    throw new Error(`posting group asset mismatch: expected ${input.asset}, got ${asset}`);
  }

  // Stable ordering makes sequence numbers (and therefore hashes) deterministic.
  const ordered = [...legs].sort(compareLegs);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const postings: LedgerPosting[] = ordered.map((leg, sequence) => {
    const identity = {
      postingGroupId,
      account: leg.account,
      asset: leg.asset,
      amountMinor: leg.amountMinor,
      direction: leg.direction,
      sequence,
    };
    const balanceProofHash = computeBalanceProofHash(identity);
    if (balanceProofHash.length === 0) {
      // Defensive: a hash function failure must never produce an unproven entry.
      throw new Error("empty balance proof hash");
    }
    return {
      ...identity,
      postingId: computePostingId(identity),
      balanceProofHash,
      createdAt,
    };
  });

  const group: PostingGroup = { postingGroupId, asset, postings, createdAt };
  const validation = validatePostingGroup(group);
  if (!validation.ok) {
    throw new Error(`unbalanced posting group ${postingGroupId}: ${validation.errors.join("; ")}`);
  }
  return group;
}

/** Verify one posting group: hashes, sequences and per-asset balance. */
export function validatePostingGroup(group: PostingGroup): ValidationResult {
  const errors: string[] = [];
  if (!group || typeof group.postingGroupId !== "string" || group.postingGroupId.length === 0) {
    return { ok: false, errors: ["missing postingGroupId"] };
  }
  if (!Array.isArray(group.postings) || group.postings.length < 2) {
    return { ok: false, errors: ["posting group has fewer than two entries"] };
  }

  const sequences = new Set<number>();
  const balances = new Map<string, { debit: number; credit: number }>();
  for (const posting of group.postings) {
    if (!Number.isSafeInteger(posting.amountMinor) || posting.amountMinor <= 0) {
      errors.push(`entry ${posting.postingId || "?"} has invalid amount`);
    }
    if (!posting.balanceProofHash || posting.balanceProofHash.length === 0) {
      errors.push(`entry ${posting.postingId || "?"} has an empty proof hash`);
    } else {
      const expected = computeBalanceProofHash(posting);
      if (posting.balanceProofHash !== expected) {
        errors.push(`entry ${posting.postingId || "?"} proof hash mismatch`);
      }
    }
    if (posting.postingGroupId !== group.postingGroupId) {
      errors.push(`entry ${posting.postingId || "?"} belongs to another group`);
    }
    if (posting.postingId && posting.postingId !== computePostingId(posting)) {
      errors.push(`entry ${posting.postingId} id mismatch`);
    }
    if (!Number.isSafeInteger(posting.sequence) || posting.sequence < 0 || sequences.has(posting.sequence)) {
      errors.push(`invalid/duplicate sequence ${String(posting.sequence)}`);
    }
    sequences.add(posting.sequence);
    const balance = balances.get(posting.asset) ?? { debit: 0, credit: 0 };
    if (posting.direction === "DEBIT") balance.debit += posting.amountMinor;
    else if (posting.direction === "CREDIT") balance.credit += posting.amountMinor;
    else errors.push(`invalid direction ${String(posting.direction)}`);
    balances.set(posting.asset, balance);
  }
  for (const [asset, balance] of balances) {
    if (balance.debit !== balance.credit) {
      errors.push(
        `${asset} imbalance: debits ${balance.debit} != credits ${balance.credit}`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Validate every posting group in a collection. */
export function validatePostings(groups: Iterable<PostingGroup>): ValidationResult {
  const errors: string[] = [];
  for (const group of groups) {
    const result = validatePostingGroup(group);
    for (const error of result.errors) errors.push(`${group?.postingGroupId ?? "?"}: ${error}`);
  }
  return { ok: errors.length === 0, errors };
}

// ===========================================================================
// Transfer helper (gross -> net + fees, always balanced)
// ===========================================================================

export interface LedgerFeeLeg {
  account: string;
  amountMinor: number;
}

export interface PostTransferInput {
  postingGroupId?: string;
  sourceAccount: string;
  destinationAccount: string;
  asset: string;
  /** Gross debited from the source account. */
  amountMinor: number;
  /** Fee credits carved out of the gross; the remainder is credited to destination. */
  feeLegs?: readonly LedgerFeeLeg[];
  createdAt?: string;
}

/**
 * Build a balanced transfer group: DEBIT source(gross), CREDIT destination(net)
 * and CREDIT each fee account. Net + fees === gross by construction.
 */
export function buildTransferGroup(input: PostTransferInput): PostingGroup {
  assertMinorAmount(input.amountMinor, "amountMinor");
  const fees = input.feeLegs ?? [];
  let feeTotal = 0;
  for (const fee of fees) {
    assertMinorAmount(fee.amountMinor, "feeLegs[].amountMinor");
    if (!fee.account || fee.account.length === 0) {
      throw new Error("feeLegs[].account must be non-empty");
    }
    feeTotal += fee.amountMinor;
    if (!Number.isSafeInteger(feeTotal)) throw new Error("fee total overflow");
  }
  const net = input.amountMinor - feeTotal;
  if (net < 0) throw new Error("fee legs exceed gross amount");

  const legs: LedgerLeg[] = [
    {
      account: input.sourceAccount,
      asset: input.asset,
      amountMinor: input.amountMinor,
      direction: "DEBIT",
    },
  ];
  if (net > 0) {
    legs.push({
      account: input.destinationAccount,
      asset: input.asset,
      amountMinor: net,
      direction: "CREDIT",
    });
  }
  for (const fee of fees) {
    if (fee.amountMinor === 0) continue;
    legs.push({
      account: fee.account,
      asset: input.asset,
      amountMinor: fee.amountMinor,
      direction: "CREDIT",
    });
  }
  return buildBalancedPostingGroup({
    postingGroupId: input.postingGroupId,
    asset: input.asset,
    legs,
    createdAt: input.createdAt,
  });
}

// ===========================================================================
// Stellar amount conversion — string based, no floating point
// ===========================================================================

const STROOPS_PER_UNIT = 10_000_000; // 7 decimals

/** Convert a Stellar amount string ("10.0000000") to integer stroops. */
export function stellarAmountToMinor(amount: string): number {
  if (typeof amount !== "string" || !/^-?\d+(?:\.\d+)?$/.test(amount.trim())) {
    throw new Error(`invalid Stellar amount: ${String(amount)}`);
  }
  const trimmed = amount.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > 7) throw new Error(`too many decimals in amount: ${amount}`);
  const padded = (fraction + "0000000").slice(0, 7);
  const minor = Number(whole) * STROOPS_PER_UNIT + Number(padded);
  if (!Number.isSafeInteger(minor)) throw new Error(`amount out of range: ${amount}`);
  return negative ? -minor : minor;
}

/** Convert integer stroops back to a 7-decimal Stellar amount string. */
export function minorToStellarAmount(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error("minor amount must be a safe integer");
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / STROOPS_PER_UNIT);
  const fraction = String(absolute % STROOPS_PER_UNIT).padStart(7, "0");
  return `${sign}${whole}.${fraction}`;
}

// ===========================================================================
// Storage ports + implementations
// ===========================================================================

export interface LedgerStore {
  saveGroup(group: PostingGroup): void | Promise<void>;
  getGroup(postingGroupId: string): PostingGroup | undefined | Promise<PostingGroup | undefined>;
  listGroups(): PostingGroup[] | Promise<PostingGroup[]>;
}

function cloneGroup(group: PostingGroup): PostingGroup {
  return JSON.parse(JSON.stringify(group)) as PostingGroup;
}

/** In-memory ledger store for unit tests / default safety net. */
export interface InMemoryLedgerStore extends LedgerStore {
  readonly groups: Map<string, PostingGroup>;
  clear(): void;
}

export function createInMemoryLedgerStore(): InMemoryLedgerStore {
  const groups = new Map<string, PostingGroup>();
  return {
    groups,
    saveGroup(group) {
      groups.set(group.postingGroupId, cloneGroup(group));
    },
    getGroup(postingGroupId) {
      const group = groups.get(postingGroupId);
      return group ? cloneGroup(group) : undefined;
    },
    listGroups() {
      return [...groups.values()].map(cloneGroup);
    },
    clear() {
      groups.clear();
    },
  };
}

/** Minimal structural database port (satisfied by better-sqlite3). */
export interface SqliteStatementPort {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
export interface SqliteDbPort {
  prepare(sql: string): SqliteStatementPort;
}

interface PostingRow {
  posting_id: string;
  posting_group_id: string;
  account: string;
  asset: string;
  amount_minor: number;
  direction: LedgerDirection;
  sequence: number;
  balance_proof_hash: string;
  created_at: string;
}

const LEDGER_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ledger_postings (
    posting_id TEXT PRIMARY KEY,
    posting_group_id TEXT NOT NULL,
    account TEXT NOT NULL,
    asset TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    direction TEXT NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
    sequence INTEGER NOT NULL,
    balance_proof_hash TEXT NOT NULL CHECK(length(balance_proof_hash) = 64),
    created_at TEXT NOT NULL,
    UNIQUE(posting_group_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_postings_group ON ledger_postings(posting_group_id);
`;

function rowToPosting(row: PostingRow): LedgerPosting {
  return {
    postingId: row.posting_id,
    postingGroupId: row.posting_group_id,
    account: row.account,
    asset: row.asset,
    amountMinor: row.amount_minor,
    direction: row.direction,
    sequence: row.sequence,
    balanceProofHash: row.balance_proof_hash,
    createdAt: row.created_at,
  };
}

/** SQLite-backed ledger store. Creates its table defensively (idempotent DDL). */
export function createSqliteLedgerStore(db: SqliteDbPort): LedgerStore {
  for (const statement of LEDGER_TABLE_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    db.prepare(statement).run();
  }
  return {
    saveGroup(group) {
      const validation = validatePostingGroup(group);
      if (!validation.ok) {
        throw new Error(`refusing to persist unbalanced group: ${validation.errors.join("; ")}`);
      }
      const insert = db.prepare(
        `INSERT OR REPLACE INTO ledger_postings
          (posting_id, posting_group_id, account, asset, amount_minor, direction, sequence, balance_proof_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of group.postings) {
        insert.run(
          p.postingId,
          p.postingGroupId,
          p.account,
          p.asset,
          p.amountMinor,
          p.direction,
          p.sequence,
          p.balanceProofHash,
          p.createdAt,
        );
      }
    },
    getGroup(postingGroupId) {
      const rows = db
        .prepare("SELECT * FROM ledger_postings WHERE posting_group_id = ? ORDER BY sequence ASC")
        .all(postingGroupId) as PostingRow[];
      if (rows.length === 0) return undefined;
      const postings = rows.map(rowToPosting);
      return {
        postingGroupId,
        asset: postings[0]?.asset ?? "",
        postings,
        createdAt: postings[0]?.createdAt ?? "",
      };
    },
    listGroups() {
      const rows = db.prepare("SELECT * FROM ledger_postings ORDER BY posting_group_id, sequence").all() as PostingRow[];
      const groups = new Map<string, PostingGroup>();
      for (const row of rows) {
        const posting = rowToPosting(row);
        const group = groups.get(row.posting_group_id) ?? {
          postingGroupId: row.posting_group_id,
          asset: posting.asset,
          postings: [],
          createdAt: posting.createdAt,
        };
        group.postings.push(posting);
        groups.set(row.posting_group_id, group);
      }
      return [...groups.values()];
    },
  };
}

// ===========================================================================
// Module-level convenience layer (no DB/timer opened on import)
// ===========================================================================

let wiredStore: LedgerStore | undefined;
let wiredLogger: LoggerPort | undefined;

const fallbackLogger: LoggerPort = {
  debug: (event, meta) => moduleLog("debug", event, meta),
  info: (event, meta) => moduleLog("info", event, meta),
  warn: (event, meta) => moduleLog("warn", event, meta),
  error: (event, meta) => moduleLog("error", event, meta),
  log: (level, event, meta) => moduleLog(level, event, meta),
};

/** Wire the ledger's store/logger (composition root / tests). */
export function initLedger(deps: { store: LedgerStore; logger?: LoggerPort }): void {
  wiredStore = deps.store;
  wiredLogger = deps.logger;
}

/** Default store shared by the module-level ledger and reconciliation helpers. */
export function getDefaultLedgerStore(): LedgerStore {
  if (!wiredStore) wiredStore = createInMemoryLedgerStore();
  return wiredStore;
}

function currentLedger(): { store: LedgerStore; logger: LoggerPort } {
  return { store: getDefaultLedgerStore(), logger: wiredLogger ?? fallbackLogger };
}

function settleAsync(result: void | Promise<void>, logger: LoggerPort, groupId: string): void {
  if (result && typeof (result as Promise<void>).then === "function") {
    (result as Promise<void>).catch((error: unknown) => {
      logger.error("ledger_group_save_failed", {
        postingGroupId: groupId,
        error: (error as Error).message,
      });
    });
  }
}

/** Build + persist a balanced posting group through the injected store. */
export function postBalancedGroup(input: BuildPostingGroupInput): PostingGroup {
  const { store, logger } = currentLedger();
  const group = buildBalancedPostingGroup(input);
  settleAsync(store.saveGroup(group), logger, group.postingGroupId);
  logger.info("ledger_group_posted", {
    postingGroupId: group.postingGroupId,
    asset: group.asset,
    entries: group.postings.length,
  });
  return group;
}

/** Build + persist a balanced transfer through the injected store. */
export function postTransfer(input: PostTransferInput): PostingGroup {
  const group = buildTransferGroup(input);
  const { store, logger } = currentLedger();
  settleAsync(store.saveGroup(group), logger, group.postingGroupId);
  logger.info("ledger_transfer_posted", {
    postingGroupId: group.postingGroupId,
    asset: group.asset,
    entries: group.postings.length,
  });
  return group;
}

/** Read one posting group from the injected store. */
export async function getPostingGroup(
  postingGroupId: string,
): Promise<PostingGroup | undefined> {
  return currentLedger().store.getGroup(postingGroupId);
}

/** Validate every posting group currently held by the injected store. */
export async function validateLedger(): Promise<ValidationResult> {
  const groups = await currentLedger().store.listGroups();
  return validatePostings(groups);
}
