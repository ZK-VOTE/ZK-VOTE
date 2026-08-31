/**
 * Groth16 Proof Canonicalization Tests (#167)
 *
 * Groth16 proofs are malleable: (A, B, C) and (-A, -B, C) both verify.
 * canonicalizeProof() picks a single representative (A's Y-coordinate in
 * the lower half of the BN254 base field Fq) so the two forms of the same
 * proof always encode identically before reaching storage or on-chain
 * submission.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { canonicalizeProof } from "../src/services/stellar.js";
import { BN254_FQ_MODULUS } from "../src/types/index.js";
import {
  initDb,
  closeDb,
  recordProofCommitment,
  getProofCommitment,
  getProofCommitmentByCanonicalHash,
} from "../src/services/db.js";

function bigIntToBytes(n, length) {
  return Buffer.from(n.toString(16).padStart(length * 2, "0"), "hex");
}

const FQ_HALF = (BN254_FQ_MODULUS - 1n) / 2n;

// An arbitrary X (canonicalization never touches X) and a Y strictly in the
// lower half of Fq (already canonical).
const AX = 0x1234n;
const LOW_Y = 5n;
const HIGH_Y = BN254_FQ_MODULUS - 5n; // > FQ_HALF, needs negation

function buildA(y) {
  return Buffer.concat([bigIntToBytes(AX, 32), bigIntToBytes(y, 32)]);
}

function buildB(yc1, yc0) {
  return Buffer.concat([
    bigIntToBytes(0xaaaan, 32), // X_c1 (untouched)
    bigIntToBytes(0xbbbbn, 32), // X_c0 (untouched)
    bigIntToBytes(yc1, 32),
    bigIntToBytes(yc0, 32),
  ]);
}

/** Build a Groth16Proof-shaped object from raw Buffer/bigint values. */
function buildProofObject(aY, bYc1, bYc0, cY = 3n) {
  const a = buildA(aY);
  const b = buildB(bYc1, bYc0);
  const c = Buffer.concat([bigIntToBytes(0xcccn, 32), bigIntToBytes(cY, 32)]);
  return {
    a: a.toString("hex"),
    b: b.toString("hex"),
    c: c.toString("hex"),
  };
}

/**
 * Replicate the computeCanonicalProofHash logic from voting.ts so we can
 * test it in isolation without spinning up a full Express app.
 */
function computeCanonicalProofHash(proof) {
  if (!proof || typeof proof !== "object") return null;
  const { a, b, c } = proof;
  if (typeof a !== "string" || typeof b !== "string" || typeof c !== "string") {
    return null;
  }
  const aBytes = Buffer.from(a.replace(/^0x/, ""), "hex");
  const bBytes = Buffer.from(b.replace(/^0x/, ""), "hex");
  if (aBytes.length !== 64 || bBytes.length !== 128) return null;

  const { a: canonA, b: canonB } = canonicalizeProof(aBytes, bBytes);
  const cHex = c.replace(/^0x/, "").toLowerCase();
  return crypto
    .createHash("sha256")
    .update(canonA.toString("hex") + canonB.toString("hex") + cHex)
    .digest("hex");
}

describe("canonicalizeProof", () => {
  it("leaves an already-canonical proof (Y in lower half) unchanged", () => {
    const a = buildA(LOW_Y);
    const b = buildB(7n, 9n);

    const result = canonicalizeProof(a, b);

    assert.strictEqual(result.a.toString("hex"), a.toString("hex"));
    assert.strictEqual(result.b.toString("hex"), b.toString("hex"));
  });

  it("negates A.Y and both B.Y components when A.Y is in the upper half", () => {
    const yc1 = 7n;
    const yc0 = 9n;
    const a = buildA(HIGH_Y);
    const b = buildB(yc1, yc0);

    const result = canonicalizeProof(a, b);

    const resultAy = BigInt("0x" + result.a.subarray(32, 64).toString("hex"));
    const resultAx = BigInt("0x" + result.a.subarray(0, 32).toString("hex"));
    assert.strictEqual(resultAx, AX, "X must be untouched");
    assert.strictEqual(resultAy, BN254_FQ_MODULUS - HIGH_Y);
    assert.ok(resultAy <= FQ_HALF, "negated Y must land in the lower half");

    const resultXc1 = result.b.subarray(0, 32).toString("hex");
    const resultXc0 = result.b.subarray(32, 64).toString("hex");
    assert.strictEqual(resultXc1, b.subarray(0, 32).toString("hex"), "B.X_c1 must be untouched");
    assert.strictEqual(resultXc0, b.subarray(32, 64).toString("hex"), "B.X_c0 must be untouched");

    const resultYc1 = BigInt("0x" + result.b.subarray(64, 96).toString("hex"));
    const resultYc0 = BigInt("0x" + result.b.subarray(96, 128).toString("hex"));
    assert.strictEqual(resultYc1, BN254_FQ_MODULUS - yc1);
    assert.strictEqual(resultYc0, BN254_FQ_MODULUS - yc0);
  });

  it("canonicalizes both malleable representations of the same proof to an identical result", () => {
    // (A, B) and (-A, -B) are the two malleable forms of the same proof.
    const a1 = buildA(HIGH_Y);
    const b1 = buildB(7n, 9n);

    const negA = BN254_FQ_MODULUS - HIGH_Y;
    const a2 = buildA(negA);
    const b2 = buildB(BN254_FQ_MODULUS - 7n, BN254_FQ_MODULUS - 9n);

    const canon1 = canonicalizeProof(a1, b1);
    const canon2 = canonicalizeProof(a2, b2);

    assert.strictEqual(canon1.a.toString("hex"), canon2.a.toString("hex"));
    assert.strictEqual(canon1.b.toString("hex"), canon2.b.toString("hex"));
  });
});

// ============================================================
// computeCanonicalProofHash tests (#341)
// ============================================================

describe("computeCanonicalProofHash", () => {
  it("returns the same hash for both malleable forms of a proof", () => {
    // Form 1: A.Y in upper half (non-canonical)
    const proof1 = buildProofObject(HIGH_Y, 7n, 9n);
    // Form 2: A.Y in lower half after negation (canonical)
    const negY = BN254_FQ_MODULUS - HIGH_Y;
    const proof2 = buildProofObject(negY, BN254_FQ_MODULUS - 7n, BN254_FQ_MODULUS - 9n);

    const hash1 = computeCanonicalProofHash(proof1);
    const hash2 = computeCanonicalProofHash(proof2);

    assert.ok(hash1 !== null, "hash1 must not be null");
    assert.ok(hash2 !== null, "hash2 must not be null");
    assert.strictEqual(hash1, hash2, "both malleable forms must hash identically");
  });

  it("returns a different hash when proof C differs", () => {
    const proof1 = buildProofObject(LOW_Y, 7n, 9n, 11n);
    const proof2 = buildProofObject(LOW_Y, 7n, 9n, 99n); // different C

    const hash1 = computeCanonicalProofHash(proof1);
    const hash2 = computeCanonicalProofHash(proof2);

    assert.ok(hash1 !== null && hash2 !== null);
    assert.notStrictEqual(hash1, hash2, "different C must produce different canonical hash");
  });

  it("returns null for a malformed proof object", () => {
    assert.strictEqual(computeCanonicalProofHash(null), null);
    assert.strictEqual(computeCanonicalProofHash({}), null);
    assert.strictEqual(computeCanonicalProofHash({ a: "deadbeef", b: "x", c: "y" }), null);
  });

  it("returns null when a/b have wrong byte lengths", () => {
    // a too short (not 64 bytes), b too short (not 128 bytes)
    const bad = {
      a: "aabb",          // 2 bytes, not 64
      b: "ccdd".repeat(4), // 16 bytes, not 128
      c: "0".repeat(128),
    };
    assert.strictEqual(computeCanonicalProofHash(bad), null);
  });

  it("produces a 64-character hex SHA-256 digest", () => {
    const proof = buildProofObject(LOW_Y, 7n, 9n);
    const hash = computeCanonicalProofHash(proof);
    assert.ok(hash !== null);
    assert.match(hash, /^[0-9a-f]{64}$/, "hash must be a 64-char hex string");
  });
});

// ============================================================
// DB dedup tests using canonical_proof_hash (#341)
// ============================================================

describe("canonical proof hash DB dedup", () => {
  let dbPath;

  beforeEach(() => {
    // Use a fresh in-memory-style temp DB for each test
    dbPath = path.join(os.tmpdir(), `zkvote-test-${crypto.randomUUID()}.db`);
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  it("stores and retrieves a proof commitment by canonical hash", () => {
    const proof = buildProofObject(LOW_Y, 7n, 9n);
    const canonicalHash = computeCanonicalProofHash(proof);
    const commitmentHash = "commitment-" + crypto.randomUUID();

    recordProofCommitment(
      commitmentHash,
      "nullifier-abc",
      1, // daoId
      42, // proposalId
      Date.now(),
      null,
      canonicalHash,
    );

    const record = getProofCommitmentByCanonicalHash(canonicalHash);
    assert.ok(record !== null, "should find record by canonical hash");
    assert.strictEqual(record.commitmentHash, commitmentHash);
    assert.strictEqual(record.canonicalProofHash, canonicalHash);
    assert.strictEqual(record.status, "COMMITTED");
  });

  it("both malleable forms of a proof map to the same DB record via canonical hash", () => {
    // Form 1 (non-canonical A.Y in upper half)
    const proof1 = buildProofObject(HIGH_Y, 7n, 9n);
    const canonHash1 = computeCanonicalProofHash(proof1);

    // Form 2 (malleable counterpart: negated A.Y, negated B.Y)
    const negY = BN254_FQ_MODULUS - HIGH_Y;
    const proof2 = buildProofObject(negY, BN254_FQ_MODULUS - 7n, BN254_FQ_MODULUS - 9n);
    const canonHash2 = computeCanonicalProofHash(proof2);

    assert.ok(canonHash1 !== null && canonHash2 !== null);
    assert.strictEqual(
      canonHash1,
      canonHash2,
      "both malleable forms must produce the same canonical hash",
    );

    // Record with form 1's canonical hash
    const commitmentHash = "commitment-" + crypto.randomUUID();
    recordProofCommitment(
      commitmentHash,
      "nullifier-xyz",
      2,
      7,
      Date.now(),
      null,
      canonHash1,
    );

    // Looking up by form 2's canonical hash should find the same record
    const record = getProofCommitmentByCanonicalHash(canonHash2);
    assert.ok(record !== null, "canonical lookup must find the committed record");
    assert.strictEqual(record.commitmentHash, commitmentHash);
  });

  it("returns null for an unknown canonical hash", () => {
    const result = getProofCommitmentByCanonicalHash("nonexistent-hash-value");
    assert.strictEqual(result, null);
  });

  it("legacy records without canonical_proof_hash are not found by canonical lookup", () => {
    // Write a record WITHOUT a canonical hash (legacy row)
    const commitmentHash = "legacy-" + crypto.randomUUID();
    recordProofCommitment(
      commitmentHash,
      "nullifier-legacy",
      3,
      10,
      Date.now(),
      null,
      null, // no canonical hash
    );

    // The legacy row is still found by its commitment_hash
    const byCommitment = getProofCommitment(commitmentHash);
    assert.ok(byCommitment !== null);
    assert.strictEqual(byCommitment.canonicalProofHash, null);

    // But canonical lookup returns null (NULL IS NOT equal to any string)
    const byCanonical = getProofCommitmentByCanonicalHash("anything");
    assert.strictEqual(byCanonical, null);
  });

  it("two different proofs with the same C but different A/B produce different canonical hashes", () => {
    const proof1 = buildProofObject(LOW_Y, 7n, 9n, 3n);
    const proof2 = buildProofObject(LOW_Y, 11n, 13n, 3n); // different B.Y values

    const hash1 = computeCanonicalProofHash(proof1);
    const hash2 = computeCanonicalProofHash(proof2);

    assert.ok(hash1 !== null && hash2 !== null);
    assert.notStrictEqual(hash1, hash2, "different proofs must produce different canonical hashes");

    const ch1 = "commitment-a-" + crypto.randomUUID();
    const ch2 = "commitment-b-" + crypto.randomUUID();
    recordProofCommitment(ch1, "n1", 4, 1, Date.now(), null, hash1);
    recordProofCommitment(ch2, "n2", 4, 1, Date.now(), null, hash2);

    const r1 = getProofCommitmentByCanonicalHash(hash1);
    const r2 = getProofCommitmentByCanonicalHash(hash2);
    assert.ok(r1 !== null && r2 !== null);
    assert.strictEqual(r1.commitmentHash, ch1);
    assert.strictEqual(r2.commitmentHash, ch2);
  });
});
