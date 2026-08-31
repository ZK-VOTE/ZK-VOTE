/**
 * Privacy-Preserving Analytics Tests (issue #306)
 *
 * Exercises the homomorphic tally aggregation end-to-end:
 *   - contributions accumulate without exposing per-voter plaintexts,
 *   - the aggregate is the only value ever threshold-decrypted,
 *   - the DKG threshold, k-anonymity floor, and privacy budget guards all gate
 *     decryption correctly.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import * as tc from "../src/services/threshold-crypto.js";
import * as analytics from "../src/services/privacy-analytics.js";
import { initDb, closeDb } from "../src/services/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDb: string;

before(() => {
  tmpDb = path.join(os.tmpdir(), `zkvote-analytics-${randomUUID()}.db`);
  initDb(tmpDb);
});

after(() => {
  closeDb();
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ignore */
  }
});

// ── Helpers ───────────────────────────────────────────────────────────

// A toy deterministic joint key (private scalar 42) used by tests that check
// the aggregate ciphertext content directly without a full DKG simulation.
const JOINT_KEY = tc.g1ToHex(tc.G1_GENERATOR.multiply(42n));

function newDaoId(): number {
  return Math.floor(Math.random() * 900000) + 1000;
}

/**
 * Run a small (t,n) DKG simulation to obtain per-authority private key shares
 * and the resulting joint public key. Contributions and the analytics
 * init must use this same `publicKey` so decryption shares verify.
 */
function dkgShares(n: number, t: number): {
  publicKey: string;
  shares: Array<{ authorityIndex: number; privateKeyShare: bigint }>;
} {
  const authorities = Array.from({ length: n }, (_, i) =>
    tc.generateDKGShares(i, t, n),
  );
  const receivedShares = Array.from({ length: n }, (_, j) =>
    authorities.map((auth, i) => ({
      fromIndex: i,
      value: auth.shares[j].value,
    })),
  );
  const allCommitments = authorities.map((a) => a.commitments);
  const results = receivedShares.map((shares) =>
    tc.computeDKGResult(shares, allCommitments),
  );
  return {
    publicKey: results[0].publicKey,
    shares: results.map((r, i) => ({
      authorityIndex: i,
      privateKeyShare: r.privateKeyShare,
    })),
  };
}

function decryptSharesForTally(
  tally: tc.Ciphertext,
  keys: Array<{ authorityIndex: number; privateKeyShare: bigint }>,
  take: number,
): Array<{ authorityIndex: number; shareHex: string }> {
  return keys.slice(0, take).map((k) => ({
    authorityIndex: k.authorityIndex,
    shareHex: tc.generateDecryptionShare(tally, k.privateKeyShare),
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Privacy-Preserving Analytics", () => {
  it("initializes an aggregate and seeds a privacy budget", () => {
    const daoId = newDaoId();
    const state = analytics.initializeAnalytics({
      daoId,
      jointPublicKey: JOINT_KEY,
      thresholdT: 2,
      thresholdN: 3,
      minCohort: 5,
    });

    assert.equal(state.contributionCount, 0);
    assert.equal(state.decrypted, false);
    assert.equal(state.jointPublicKey, JOINT_KEY);

    const budget = analytics.getPrivacyBudget(daoId);
    assert.equal(budget.minCohort, 5);
    assert.equal(budget.epsilonBudget, 1.0);
    assert.equal(budget.remaining, 1.0);
  });

  it("rejects re-initialization with a mismatched joint public key", () => {
    const daoId = newDaoId();
    analytics.initializeAnalytics({
      daoId,
      jointPublicKey: JOINT_KEY,
      thresholdT: 2,
      thresholdN: 3,
    });
    assert.throws(
      () =>
        analytics.initializeAnalytics({
          daoId,
          jointPublicKey: tc.g1ToHex(tc.G1_GENERATOR.multiply(7n)),
          thresholdT: 2,
          thresholdN: 3,
        }),
      /Joint public key mismatch/,
    );
  });

  it("accumulates encrypted contributions homomorphically", () => {
    const daoId = newDaoId();
    analytics.initializeAnalytics({
      daoId,
      jointPublicKey: JOINT_KEY,
      thresholdT: 2,
      thresholdN: 3,
      minCohort: 3,
    });

    // Each contribution is a ciphertext of 1 (participation). We fold 4 in.
    for (let i = 0; i < 4; i++) {
      analytics.accumulateContribution(daoId, tc.encryptVote(JOINT_KEY, 1n));
    }

    const state = analytics.getState(daoId);
    assert.equal(state.contributionCount, 4);
    // The stored aggregate must decrypt to 4 (4 participants) under the joint key.
    const decrypted = tc.decryptVote(
      { c1: state.aggregateC1, c2: state.aggregateC2 },
      42n, // joint private key used for JOINT_KEY = 42 * G
    );
    assert.equal(decrypted, 4n);

    // The analytics store must NOT expose any per-voter ciphertext: there is
    // no field for it, and the count is all that is revealed.
    assert.deepEqual(
      Object.keys(state).filter((k) => /vote|ciphertext|contribution/i.test(k)),
      ["contributionCount"],
    );
  });

  it("refuses to decrypt a cohort below the k-anonymity floor", () => {
    const daoId = newDaoId();
    const { publicKey, shares } = dkgShares(3, 2);
    analytics.initializeAnalytics({
      daoId,
      jointPublicKey: publicKey,
      thresholdT: 2,
      thresholdN: 3,
      minCohort: 5,
    });

    // Only 3 contributions < minCohort=5.
    for (let i = 0; i < 3; i++) {
      analytics.accumulateContribution(daoId, tc.encryptVote(publicKey, 1n));
    }
    const agg = analytics.getState(daoId);
    const tally: tc.Ciphertext = { c1: agg.aggregateC1, c2: agg.aggregateC2 };
    const decShares = decryptSharesForTally(tally, shares, 2);

    assert.throws(
      () => analytics.thresholdDecryptAggregate(daoId, decShares),
      /Cohort too small/,
    );
  });

  it("refuses to decrypt without the threshold number of shares", () => {
    const daoId = newDaoId();
    const { publicKey, shares } = dkgShares(3, 2);
    analytics.initializeAnalytics({
      daoId,
      jointPublicKey: publicKey,
      thresholdT: 2,
      thresholdN: 3,
      minCohort: 1,
    });

    for (let i = 0; i < 5; i++) {
      analytics.accumulateContribution(daoId, tc.encryptVote(publicKey, 1n));
    }
    const agg = analytics.getState(daoId);
    const tally: tc.Ciphertext = { c1: agg.aggregateC1, c2: agg.aggregateC2 };

    // Only 1 share, but threshold = 2.
    assert.throws(
      () =>
        analytics.thresholdDecryptAggregate(daoId, [
          decryptSharesForTally(tally, shares, 2)[0],
        ]),
      /Insufficient decryption shares/,
    );

    // With real threshold shares it succeeds.
    const result = analytics.thresholdDecryptAggregate(
      daoId,
      decryptSharesForTally(tally, shares, 2),
    );
    assert.equal(result.tally, 5n);
  });

  it("decrypts only the aggregate (never per-voter) and is single-shot", () => {
    const daoId = newDaoId();
    const { publicKey, shares } = dkgShares(3, 2);
    analytics.initializeAnalytics({
      daoId,
      jointPublicKey: publicKey,
      thresholdT: 2,
      thresholdN: 3,
      minCohort: 2,
    });

    // 4 participants (encrypted 1 each).
    for (let i = 0; i < 4; i++) {
      analytics.accumulateContribution(daoId, tc.encryptVote(publicKey, 1n));
    }
    const agg = analytics.getState(daoId);
    const tally: tc.Ciphertext = { c1: agg.aggregateC1, c2: agg.aggregateC2 };
    const decShares = decryptSharesForTally(tally, shares, 2);

    const result = analytics.thresholdDecryptAggregate(daoId, decShares);
    assert.equal(result.tally, 4n);
    assert.ok(result.proof.length > 0);
    assert.ok(result.combinedShare.length > 0);

    // Aggregate is now marked decrypted; further decryption is refused.
    assert.equal(analytics.getState(daoId).decrypted, true);
    assert.throws(
      () => analytics.thresholdDecryptAggregate(daoId, decShares),
      /already decrypted/,
    );

    // Privacy budget was debited.
    assert.equal(analytics.getPrivacyBudget(daoId).epsilonSpent, 0.1);
  });

  it("refuses decryption once the privacy budget is exhausted", () => {
    const daoId = newDaoId();
    const { publicKey, shares } = dkgShares(3, 2);
    analytics.initializeAnalytics({
      daoId,
      jointPublicKey: publicKey,
      thresholdT: 2,
      thresholdN: 3,
      minCohort: 1,
      epsilonBudget: 1.0,
      epsilonPerQuery: 0.9,
    });

    for (let i = 0; i < 4; i++) {
      analytics.accumulateContribution(daoId, tc.encryptVote(publicKey, 1n));
    }
    const agg = analytics.getState(daoId);
    const tally = { c1: agg.aggregateC1, c2: agg.aggregateC2 };
    const decShares = decryptSharesForTally(tally, shares, 2);

    // First decrypt: budget 1.0 - 0.9 = 0.1 remaining.
    analytics.thresholdDecryptAggregate(daoId, decShares);

    // Budget exhausted -> but aggregate is already decrypted, so this throws
    // the "already decrypted" guard first. To isolate the budget guard, use a
    // fresh DAO that starts already "spent up".
    const daoId2 = newDaoId();
    analytics.initializeAnalytics({
      daoId: daoId2,
      jointPublicKey: publicKey,
      thresholdT: 2,
      thresholdN: 3,
      minCohort: 1,
      epsilonBudget: 0.05,
      epsilonPerQuery: 0.1,
    });
    for (let i = 0; i < 4; i++) {
      analytics.accumulateContribution(daoId2, tc.encryptVote(publicKey, 1n));
    }
    const agg2 = analytics.getState(daoId2);
    const tally2 = { c1: agg2.aggregateC1, c2: agg2.aggregateC2 };
    assert.throws(
      () => analytics.thresholdDecryptAggregate(daoId2, decryptSharesForTally(tally2, shares, 2)),
      /Privacy budget exhausted/,
    );
  });

  it("dedupes duplicate authority shares before combining", () => {
    const daoId = newDaoId();
    const { publicKey, shares } = dkgShares(3, 2);
    analytics.initializeAnalytics({
      daoId,
      jointPublicKey: publicKey,
      thresholdT: 2,
      thresholdN: 3,
      minCohort: 1,
    });
    for (let i = 0; i < 6; i++) {
      analytics.accumulateContribution(daoId, tc.encryptVote(publicKey, 1n));
    }
    const agg = analytics.getState(daoId);
    const tally = { c1: agg.aggregateC1, c2: agg.aggregateC2 };
    const twoShares = decryptSharesForTally(tally, shares, 2);

    // Duplicate the first authority's share; must still decrypt to 6.
    const result = analytics.thresholdDecryptAggregate(daoId, [
      twoShares[0],
      twoShares[0],
      twoShares[1],
    ]);
    assert.equal(result.tally, 6n);
  });
});