/**
 * Tests for issue #310 – VDF + threshold randomness for proposal ordering
 *
 * Covers:
 *  - VDF service: computeVdf, verifyVdf, deriveVdfInput
 *  - Seeded shuffle: determinism, coverage, edge cases
 *  - Replay-safety nonce computation
 *  - Threshold share combination (XOR)
 *  - Proposal ID normalisation (dedup + sort)
 *  - End-to-end ordering flow (seed → contribute → finalize → verify)
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// ─── Import VDF service ───────────────────────────────────────────────────────

const { computeVdf, verifyVdf, deriveVdfInput } = await import(
  "../src/services/vdf.js"
);

// ─── VDF – computeVdf ─────────────────────────────────────────────────────────

test("computeVdf: returns 64-hex-char output", () => {
  const { output } = computeVdf(crypto.randomBytes(32).toString("hex"), 100);
  assert.equal(output.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(output));
});

test("computeVdf: is deterministic for same input + iterations", () => {
  const input = "a".repeat(64);
  const { output: o1 } = computeVdf(input, 50);
  const { output: o2 } = computeVdf(input, 50);
  assert.equal(o1, o2);
});

test("computeVdf: different inputs produce different outputs", () => {
  const { output: o1 } = computeVdf("0".repeat(64), 50);
  const { output: o2 } = computeVdf("f".repeat(64), 50);
  assert.notEqual(o1, o2);
});

test("computeVdf: different iterations produce different outputs", () => {
  const input = "b".repeat(64);
  const { output: o1 } = computeVdf(input, 10);
  const { output: o2 } = computeVdf(input, 20);
  assert.notEqual(o1, o2);
});

test("computeVdf: returns non-empty checkpoints array", () => {
  const { checkpoints } = computeVdf("0".repeat(64), 100);
  assert.ok(Array.isArray(checkpoints));
  assert.ok(checkpoints.length > 0);
});

test("computeVdf: records non-negative duration", () => {
  const { duration } = computeVdf("0".repeat(64), 100);
  assert.ok(typeof duration === "number" && duration >= 0);
});

// ─── VDF – verifyVdf ──────────────────────────────────────────────────────────

test("verifyVdf: accepts valid output + checkpoints", () => {
  const input = "c".repeat(64);
  const { output, checkpoints } = computeVdf(input, 200);
  assert.ok(verifyVdf(input, 200, output, checkpoints));
});

test("verifyVdf: rejects tampered output", () => {
  const input = "d".repeat(64);
  const { checkpoints } = computeVdf(input, 100);
  assert.ok(!verifyVdf(input, 100, "0".repeat(64), checkpoints));
});

test("verifyVdf: rejects wrong checkpoints", () => {
  const input = "e".repeat(64);
  const { output } = computeVdf(input, 100);
  assert.ok(!verifyVdf(input, 100, output, ["0".repeat(64)]));
});

test("verifyVdf: requires matching checkpoints at expected intervals (empty checkpoints fail)", () => {
  // verifyVdf requires checkpoints at correct intervals; an empty array will
  // fail because the implementation checks each interval boundary.
  const input = "f".repeat(64);
  const { output } = computeVdf(input, 50);
  // This is expected to return false because checkpoints are required
  assert.ok(!verifyVdf(input, 50, output, []),
    "verifyVdf with empty checkpoints should return false (checkpoints required)");
});

// ─── VDF – deriveVdfInput ─────────────────────────────────────────────────────

test("deriveVdfInput: returns 64-hex-char string", () => {
  const result = deriveVdfInput(1, 42, "0".repeat(64), "f".repeat(64));
  assert.equal(result.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(result));
});

test("deriveVdfInput: is deterministic", () => {
  const r1 = deriveVdfInput(1, 1, "a".repeat(64), "b".repeat(64));
  const r2 = deriveVdfInput(1, 1, "a".repeat(64), "b".repeat(64));
  assert.equal(r1, r2);
});

test("deriveVdfInput: changes with different daoId", () => {
  const r1 = deriveVdfInput(1, 1, "a".repeat(64), "b".repeat(64));
  const r2 = deriveVdfInput(2, 1, "a".repeat(64), "b".repeat(64));
  assert.notEqual(r1, r2);
});

test("deriveVdfInput: changes with different proposalId", () => {
  const r1 = deriveVdfInput(1, 1, "a".repeat(64), "b".repeat(64));
  const r2 = deriveVdfInput(1, 2, "a".repeat(64), "b".repeat(64));
  assert.notEqual(r1, r2);
});

// ─── Seeded shuffle ───────────────────────────────────────────────────────────

function seededShuffle(ids, seedHex) {
  const arr = [...ids];
  let state = Buffer.from(seedHex, "hex");
  for (let i = arr.length - 1; i > 0; i--) {
    state = crypto.createHash("sha256").update(state).digest();
    const j = state.readUInt32BE(0) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const seed = "a".repeat(64);
const ids  = [1, 2, 3, 4, 5];

test("seededShuffle: returns same length as input", () => {
  assert.equal(seededShuffle(ids, seed).length, ids.length);
});

test("seededShuffle: contains all original IDs", () => {
  const result = seededShuffle(ids, seed);
  assert.deepEqual([...result].sort((a, b) => a - b), [...ids]);
});

test("seededShuffle: is deterministic for same seed", () => {
  assert.deepEqual(seededShuffle(ids, seed), seededShuffle(ids, seed));
});

test("seededShuffle: different seeds produce different orderings", () => {
  const r1 = seededShuffle(ids, "a".repeat(64));
  const r2 = seededShuffle(ids, "b".repeat(64));
  assert.notDeepEqual(r1, r2);
});

test("seededShuffle: single element", () => {
  assert.deepEqual(seededShuffle([99], seed), [99]);
});

test("seededShuffle: empty list", () => {
  assert.deepEqual(seededShuffle([], seed), []);
});

// ─── Replay-safety nonce ──────────────────────────────────────────────────────

function computeReplayNonce(daoId, proposalIds, vdfOutput) {
  const daoIdBuf = Buffer.alloc(8);
  daoIdBuf.writeBigUInt64BE(BigInt(daoId));
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([daoIdBuf, Buffer.from(proposalIds.join(",")), Buffer.from(vdfOutput, "hex")]))
    .digest("hex");
}

test("replayNonce: is deterministic", () => {
  assert.equal(
    computeReplayNonce(1, [1, 2, 3], "a".repeat(64)),
    computeReplayNonce(1, [1, 2, 3], "a".repeat(64)),
  );
});

test("replayNonce: changes with different daoId", () => {
  assert.notEqual(
    computeReplayNonce(1, [1, 2, 3], "a".repeat(64)),
    computeReplayNonce(2, [1, 2, 3], "a".repeat(64)),
  );
});

test("replayNonce: changes with different proposalIds", () => {
  assert.notEqual(
    computeReplayNonce(1, [1, 2, 3], "a".repeat(64)),
    computeReplayNonce(1, [1, 2, 4], "a".repeat(64)),
  );
});

test("replayNonce: changes with different VDF output", () => {
  assert.notEqual(
    computeReplayNonce(1, [1, 2, 3], "a".repeat(64)),
    computeReplayNonce(1, [1, 2, 3], "b".repeat(64)),
  );
});

test("replayNonce: returns 64-hex-char string", () => {
  const nonce = computeReplayNonce(1, [1, 2], "a".repeat(64));
  assert.equal(nonce.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(nonce));
});

// ─── Threshold share combination ──────────────────────────────────────────────

function combineShares(shareHexes) {
  if (!shareHexes.length) return crypto.randomBytes(32).toString("hex");
  const combined = Buffer.from(shareHexes[0], "hex");
  for (let i = 1; i < shareHexes.length; i++) {
    const share = Buffer.from(shareHexes[i], "hex");
    for (let j = 0; j < 32; j++) combined[j] ^= share[j];
  }
  return combined.toString("hex");
}

test("combineShares: single share passes through", () => {
  const share = "ab".repeat(32);
  assert.equal(combineShares([share]), share);
});

test("combineShares: XOR of identical shares is all zeros", () => {
  const share = "ab".repeat(32);
  assert.equal(combineShares([share, share]), "00".repeat(32));
});

test("combineShares: is order-independent (3 shares)", () => {
  const [s1, s2, s3] = ["11".repeat(32), "22".repeat(32), "44".repeat(32)];
  assert.equal(combineShares([s1, s2, s3]), combineShares([s3, s1, s2]));
});

test("combineShares: different share sets give different results", () => {
  assert.notEqual(
    combineShares(["aa".repeat(32), "bb".repeat(32)]),
    combineShares(["aa".repeat(32), "cc".repeat(32)]),
  );
});

// ─── Proposal ID normalization ────────────────────────────────────────────────

function normalizeProposalIds(ids) {
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

test("normalizeProposalIds: removes duplicates and sorts", () => {
  assert.deepEqual(normalizeProposalIds([3, 1, 2, 1, 3]), [1, 2, 3]);
});

test("normalizeProposalIds: empty input", () => {
  assert.deepEqual(normalizeProposalIds([]), []);
});

test("normalizeProposalIds: single element", () => {
  assert.deepEqual(normalizeProposalIds([42]), [42]);
});

// ─── End-to-end ordering flow ─────────────────────────────────────────────────

test("e2e flow: seed → threshold mix → shuffle → verify", () => {
  const blockHash = crypto.randomBytes(32).toString("hex");
  const adminSeed = crypto.randomBytes(32).toString("hex");
  const rawIds = [3, 1, 4, 1, 5]; // duplicates on purpose
  const normalizedIds = normalizeProposalIds(rawIds);

  const vdfInput = deriveVdfInput(1, normalizedIds[0], blockHash, adminSeed);

  // Low iterations for test speed
  const { output: vdfOutput, checkpoints } = computeVdf(vdfInput, 100);

  // Two threshold shares
  const s1 = crypto.randomBytes(32).toString("hex");
  const s2 = crypto.randomBytes(32).toString("hex");
  const authContrib = combineShares([s1, s2]);

  // Final seed
  const finalSeed = crypto
    .createHash("sha256")
    .update(Buffer.from(vdfOutput, "hex"))
    .update(Buffer.from(authContrib, "hex"))
    .digest("hex");

  const ordering = seededShuffle(normalizedIds, finalSeed);

  // 1. All IDs present
  assert.deepEqual([...ordering].sort((a, b) => a - b), normalizedIds);

  // 2. VDF verifies
  assert.ok(verifyVdf(vdfInput, 100, vdfOutput, checkpoints));

  // 3. Deterministic
  assert.deepEqual(seededShuffle(normalizedIds, finalSeed), ordering);

  // 4. Replay nonce is self-consistent
  const nonce1 = computeReplayNonce(1, normalizedIds, vdfOutput);
  const nonce2 = computeReplayNonce(1, normalizedIds, vdfOutput);
  assert.equal(nonce1, nonce2);

  // 5. Different nonce for different DAO
  const nonceOther = computeReplayNonce(99, normalizedIds, vdfOutput);
  assert.notEqual(nonce1, nonceOther);
});
