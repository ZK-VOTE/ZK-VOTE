/**
 * Privacy-Preserving Analytics (homomorphic tally aggregates) — issue #306
 *
 * Computes turnout / participation analytics for a DAO WITHOUT ever decrypting
 * per-voter contributions. The core idea:
 *
 *   1. Each participation contribution is a fresh ElGamal encryption of `vote=1`
 *      under the DAO's DKG joint public key. The plaintext per-slot is never
 *      revealed or stored.
 *   2. Contributions are folded into a single per-DAO *aggregate* ciphertext via
 *      homomorphic addition. The aggregate therefore equals the number of
 *      participants, but indexers / the relayer see only the two ciphertext
 *      points (c1, c2).
 *   3. Only the aggregate — over the whole DAO or a cohort of proposals — is ever
 *      threshold-decrypted, and only after:
 *        - enough decryption share authorities have contributed (>= t), and
 *        - the cohort meets the DAO's k-anonymity floor (min_cohort), and
 *        - the DAO's privacy budget (ε) still has budget left.
 *
 * A per-DAO monotonically-spent ε budget bounds how many aggregates may be
 * decrypted in a window, so an attacker cannot repeatedly slice/difference
 * aggregates down to a single voter. See THREAT_MODEL.md §Privacy-Preserving
 * Analytics and the DKG/threshold-decryption primitives in ./threshold-crypto.ts.
 */

import { getWriteDb, getReadDb } from "./db.js";
import { log } from "./logger.js";
import * as tc from "./threshold-crypto.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface AnalyticsConfig {
  daoId: number;
  jointPublicKey: string;
  thresholdT: number;
  thresholdN: number;
  /** k-anonymity floor: never decrypt a cohort smaller than this. */
  minCohort?: number;
  /** per-query ε cost. */
  epsilonPerQuery?: number;
  /** total ε budget for the window. */
  epsilonBudget?: number;
}

export interface AnalyticsState {
  daoId: number;
  jointPublicKey: string;
  thresholdT: number;
  thresholdN: number;
  contributionCount: number;
  aggregateC1: string;
  aggregateC2: string;
  decrypted: boolean;
  lastDecryptedTally: string;
  decryptedAt: string | null;
  updatedAt: string;
}

export interface PrivacyBudgetState {
  daoId: number;
  epsilonBudget: number;
  epsilonSpent: number;
  epsilonPerQuery: number;
  minCohort: number;
  remaining: number;
}

export interface DecryptResult {
  tally: bigint;
  tallyStr: string;
  proof: string;
  combinedShare: string;
  spentEpsilon: number;
  remainingEpsilon: number;
}

// ── Defaults ──────────────────────────────────────────────────────────

const DEFAULT_MIN_COHORT = 5;
const DEFAULT_EPSILON_PER_QUERY = 0.1;
const DEFAULT_EPSILON_BUDGET = 1.0;

// ── Errors ────────────────────────────────────────────────────────────

export class PrivacyAnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyAnalyticsError";
  }
}

// ── DB Row Types ──────────────────────────────────────────────────────

interface AggregateRow {
  dao_id: number;
  joint_public_key: string;
  aggregate_c1: string;
  aggregate_c2: string;
  contribution_count: number;
  threshold_t: number;
  threshold_n: number;
  decrypted: number;
  last_decrypted_tally: string | null;
  decrypted_at: string | null;
  updated_at: string;
}

interface BudgetRow {
  dao_id: number;
  epsilon_budget: number;
  epsilon_spent: number;
  epsilon_per_query: number;
  min_cohort: number;
  window_started_at: string;
  updated_at: string;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Initialize the analytics aggregate for a DAO. Idempotent — re-initialising
 * with the same joint public key is a no-op; a mismatched key is rejected.
 */
export function initializeAnalytics(cfg: AnalyticsConfig): AnalyticsState {
  validateDaoId(cfg.daoId);
  if (!cfg.jointPublicKey) {
    throw new PrivacyAnalyticsError("jointPublicKey is required");
  }
  if (cfg.thresholdT < 1 || cfg.thresholdT > cfg.thresholdN || cfg.thresholdN > 32) {
    throw new PrivacyAnalyticsError("Invalid DKG threshold parameters");
  }
  const minCohort = cfg.minCohort ?? DEFAULT_MIN_COHORT;
  if (minCohort < 1) {
    throw new PrivacyAnalyticsError("minCohort must be >= 1");
  }

  const writeDb = getWriteDb();
  const tx = writeDb.transaction(() => {
    const existing = getAggregateRow(cfg.daoId);
    if (existing) {
      if (existing.joint_public_key !== cfg.jointPublicKey) {
        throw new PrivacyAnalyticsError(
          "Joint public key mismatch for existing analytics aggregate",
        );
      }
      return existing;
    }

    writeDb
      .prepare(
        `INSERT OR REPLACE INTO analytics_aggregates
          (dao_id, joint_public_key, aggregate_c1, aggregate_c2,
           contribution_count, threshold_t, threshold_n, decrypted,
           last_decrypted_tally, decrypted_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, 0, NULL, NULL, ?)`,
      )
      .run(
        cfg.daoId,
        cfg.jointPublicKey,
        "0", // c1 = point at infinity (identity)
        "0",
        cfg.thresholdT,
        cfg.thresholdN,
        isoNow(),
      );

    // Seed the privacy budget row.
    writeDb
      .prepare(
        `INSERT OR REPLACE INTO privacy_budget
          (dao_id, epsilon_budget, epsilon_spent, epsilon_per_query,
           min_cohort, window_started_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        cfg.daoId,
        cfg.epsilonBudget ?? DEFAULT_EPSILON_BUDGET,
        cfg.epsilonPerQuery ?? DEFAULT_EPSILON_PER_QUERY,
        minCohort,
        isoNow(),
        isoNow(),
      );
  });

  tx();
  // Read through the committed snapshot after the transaction commits.
  return getState(cfg.daoId);
}

/**
 * Fold one encrypted participation contribution into the DAO aggregate via
 * homomorphic addition. The individual contribution is discarded immediately,
 * so per-voter participation is never recoverable from the analytics store.
 */
export function accumulateContribution(
  daoId: number,
  contribution: tc.Ciphertext,
): AnalyticsState {
  validateDaoId(daoId);
  const writeDb = getWriteDb();

  const row = getAggregateRow(daoId);
  if (!row) {
    throw new PrivacyAnalyticsError("Analytics not initialized for DAO");
  }
  if (row.decrypted === 1) {
    throw new PrivacyAnalyticsError("Aggregate already decrypted; analytics closed");
  }

  // The stored ciphertext uses "0" to denote the point at infinity when no
  // contributions have landed yet. hexToG1("0") is not a valid curve point, so
  // the first contribution seeds the aggregate directly rather than being added
  // to an identity that cannot be parsed.
  const next = row.contribution_count === 0
    ? contribution
    : tc.homomorphicAdd(
        { c1: row.aggregate_c1, c2: row.aggregate_c2 },
        contribution,
      );

  writeDb
    .prepare(
      `UPDATE analytics_aggregates
         SET aggregate_c1 = ?, aggregate_c2 = ?, contribution_count = contribution_count + 1,
             updated_at = ?
       WHERE dao_id = ?`,
    )
    .run(next.c1, next.c2, isoNow(), daoId);
  log("info", "analytics_contribution_accumulated", {
    daoId,
    contributionCount: row.contribution_count + 1,
  });

  return getState(daoId);
}

/**
 * Return the current analytics state (aggregate ciphertext + cohort size).
 * This NEVER decrypts and is safe to expose: it reveals only the cohort size,
 * which is public on-chain, and the two ciphertext points.
 */
export function getState(daoId: number): AnalyticsState {
  validateDaoId(daoId);
  const row = getAggregateRow(daoId);
  if (!row) {
    throw new PrivacyAnalyticsError("Analytics not initialized for DAO");
  }
  return rowToState(row);
}

/**
 * Return the DAO's privacy budget accounting (does not require a DKG joint key).
 */
export function getPrivacyBudget(daoId: number): PrivacyBudgetState {
  validateDaoId(daoId);
  const readDb = getReadDb();
  const row = readDb
    .prepare("SELECT * FROM privacy_budget WHERE dao_id = ?")
    .get(daoId) as BudgetRow | undefined;
  if (!row) {
    return {
      daoId,
      epsilonBudget: DEFAULT_EPSILON_BUDGET,
      epsilonSpent: 0,
      epsilonPerQuery: DEFAULT_EPSILON_PER_QUERY,
      minCohort: DEFAULT_MIN_COHORT,
      remaining: DEFAULT_EPSILON_BUDGET,
    };
  }
  return rowToBudget(row);
}

/**
 * Threshold-decrypt the DAO *aggregate* only.
 *
 * Guards (all must pass, otherwise the aggregate is refused):
 *   - the aggregate is not already decrypted (single-decrypt semantics),
 *   - at least `threshold_t` distinct authority decryption shares are supplied,
 *   - the cohort meets the k-anonymity floor (`min_cohort`),
 *   - ε budget remains for at least one more decryption.
 *
 * On success the ε budget is debited and the aggregate is marked decrypted.
 */
export function thresholdDecryptAggregate(
  daoId: number,
  shares: Array<{ authorityIndex: number; shareHex: string }>,
): DecryptResult {
  validateDaoId(daoId);
  const writeDb = getWriteDb();
  const agg = getAggregateRow(daoId);
  if (!agg) {
    throw new PrivacyAnalyticsError("Analytics not initialized for DAO");
  }
  if (agg.decrypted === 1) {
    throw new PrivacyAnalyticsError("Aggregate already decrypted");
  }

  // 1. Threshold requirement.
  const uniqueShares = dedupeShares(shares);
  if (uniqueShares.length < agg.threshold_t) {
    throw new PrivacyAnalyticsError(
      `Insufficient decryption shares: have ${uniqueShares.length}, need ${agg.threshold_t}`,
    );
  }

  // 2. k-anonymity floor (also rejects an empty/zero-cohort aggregate).
  if (agg.contribution_count < 1) {
    throw new PrivacyAnalyticsError("No contributions to decrypt");
  }
  if (agg.contribution_count < aggGuard(daoId).min_cohort) {
    throw new PrivacyAnalyticsError(
      `Cohort too small to decrypt: ${agg.contribution_count} < ${aggGuard(daoId).min_cohort}`,
    );
  }

  // 3. Privacy budget check.
  const budget = getPrivacyBudget(daoId);
  const perQuery = aggEpsilonPerQuery(daoId);
  if (budget.remaining < perQuery) {
    throw new PrivacyAnalyticsError("Privacy budget exhausted");
  }

  const ciphertext: tc.Ciphertext = {
    c1: agg.aggregate_c1,
    c2: agg.aggregate_c2,
  };
  const combinedShare = tc.combineDecryptionShares(uniqueShares);
  const tally = tc.decryptTally(ciphertext, combinedShare);
  const proof = tc.generateTallyProof(ciphertext, combinedShare, tally, 0n);

  // Debit ε and mark decrypted atomically (single-decrypt semantics).
  writeDb.transaction(() => {
    writeDb
      .prepare(
        `UPDATE privacy_budget
           SET epsilon_spent = epsilon_spent + ?, updated_at = ?
         WHERE dao_id = ?`,
      )
      .run(perQuery, isoNow(), daoId);
    writeDb
      .prepare(
        `UPDATE analytics_aggregates
           SET decrypted = 1, last_decrypted_tally = ?, decrypted_at = ?, updated_at = ?
         WHERE dao_id = ? AND decrypted = 0`,
      )
      .run(tally.toString(), isoNow(), isoNow(), daoId);
  })();

  const remainingEpsilon = round2(budget.remaining - perQuery);
  log("info", "analytics_aggregate_decrypted", {
    daoId,
    tally: tally.toString(),
    spentEpsilon: perQuery,
    remainingEpsilon,
    cohort: agg.contribution_count,
  });

  return {
    tally,
    tallyStr: tally.toString(),
    proof,
    combinedShare,
    spentEpsilon: perQuery,
    remainingEpsilon,
  };
}

/**
 * Reset the DAO's privacy budget window (admin operation). Kept explicit and
 * auditable rather than implicit.
 */
export function resetPrivacyBudget(daoId: number, newBudget?: number): PrivacyBudgetState {
  validateDaoId(daoId);
  const writeDb = getWriteDb();
  writeDb
    .prepare(
      `UPDATE privacy_budget
         SET epsilon_budget = ?, epsilon_spent = 0, window_started_at = ?, updated_at = ?
       WHERE dao_id = ?`,
    )
    .run(
      newBudget ?? DEFAULT_EPSILON_BUDGET,
      isoNow(),
      isoNow(),
      daoId,
    );
  return getPrivacyBudget(daoId);
}

// ── Internal helpers ──────────────────────────────────────────────────

function getAggregateRow(daoId: number): AggregateRow | undefined {
  return getReadDb()
    .prepare("SELECT * FROM analytics_aggregates WHERE dao_id = ?")
    .get(daoId) as AggregateRow | undefined;
}

function aggGuard(daoId: number): BudgetRow {
  const readDb = getReadDb();
  return (
    (readDb
      .prepare("SELECT * FROM privacy_budget WHERE dao_id = ?")
      .get(daoId) as BudgetRow | undefined) ?? {
      dao_id: daoId,
      epsilon_budget: DEFAULT_EPSILON_BUDGET,
      epsilon_spent: 0,
      epsilon_per_query: DEFAULT_EPSILON_PER_QUERY,
      min_cohort: DEFAULT_MIN_COHORT,
      window_started_at: isoNow(),
      updated_at: isoNow(),
    }
  );
}

function aggEpsilonPerQuery(daoId: number): number {
  const row = aggGuard(daoId);
  return row.epsilon_per_query > 0
    ? row.epsilon_per_query
    : DEFAULT_EPSILON_PER_QUERY;
}

function rowToState(row: AggregateRow): AnalyticsState {
  return {
    daoId: row.dao_id,
    jointPublicKey: row.joint_public_key,
    thresholdT: row.threshold_t,
    thresholdN: row.threshold_n,
    contributionCount: row.contribution_count,
    aggregateC1: row.aggregate_c1,
    aggregateC2: row.aggregate_c2,
    decrypted: row.decrypted === 1,
    lastDecryptedTally: row.last_decrypted_tally ?? "",
    decryptedAt: row.decrypted_at,
    updatedAt: row.updated_at,
  };
}

function rowToBudget(row: BudgetRow): PrivacyBudgetState {
  return {
    daoId: row.dao_id,
    epsilonBudget: row.epsilon_budget,
    epsilonSpent: round2(row.epsilon_spent),
    epsilonPerQuery: row.epsilon_per_query,
    minCohort: row.min_cohort,
    remaining: round2(row.epsilon_budget - row.epsilon_spent),
  };
}

function dedupeShares(
  shares: Array<{ authorityIndex: number; shareHex: string }>,
): Array<{ authorityIndex: number; shareHex: string }> {
  const map = new Map<number, string>();
  for (const s of shares) {
    map.set(s.authorityIndex, s.shareHex);
  }
  return [...map.entries()].map(([authorityIndex, shareHex]) => ({
    authorityIndex,
    shareHex,
  }));
}

function validateDaoId(daoId: number): void {
  if (!Number.isInteger(daoId) || daoId < 1 || daoId > 999999) {
    throw new PrivacyAnalyticsError(`Invalid DAO ID: ${daoId}`);
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}