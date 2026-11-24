/**
 * Cross-boundary ZKV1 tests. These exercise the generated binding directly so
 * the SDK, frontend and relayer are proven to share one serializer and one
 * legacy snarkjs adapter.
 *
 * Run with: node --experimental-strip-types --test backend/test/zkv1-adapter.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  B_COORDINATE_ORDER,
  NUM_PUBLIC_SIGNALS,
  PROOF_FORMAT_VERSION,
  PUBLIC_SIGNALS,
  SERIALIZED_PROOF_LEN,
  ProofFormatError,
  deserializeProofBytes,
  encodePublicSignalsBE,
  serializeProofBytes,
  snarkjsToZkv1,
  zkv1ToSnarkjs,
} from "../src/generated/zkv1.ts";

const SAMPLE_SNARKJS = {
  pi_a: ["1", "2", "1"],
  pi_b: [
    ["3", "4"],
    ["5", "6"],
  ],
  pi_c: ["7", "8", "1"],
  protocol: "groth16",
  curve: "bn128",
};

test("ZKV1 constants are generated from one schema", () => {
  assert.equal(PROOF_FORMAT_VERSION, 1);
  assert.equal(SERIALIZED_PROOF_LEN, 258);
  assert.equal(NUM_PUBLIC_SIGNALS, 6);
  assert.deepEqual([...PUBLIC_SIGNALS.vote_v1], [
    "root",
    "nullifier",
    "daoId",
    "proposalId",
    "voteChoice",
    "numCandidates",
  ]);
  assert.deepEqual([...B_COORDINATE_ORDER], ["x_c1", "x_c0", "y_c1", "y_c0"]);
});

test("legacy snarkjs proof is converted at the single adapter boundary", () => {
  const zkv1 = snarkjsToZkv1(SAMPLE_SNARKJS);
  const hex = (n) => BigInt(n).toString(16).padStart(64, "0");
  // G2 is stored c1-first, matching Soroban/Ethereum.
  assert.equal(zkv1.a, "0x" + hex(1) + hex(2));
  assert.equal(zkv1.b, "0x" + hex(4) + hex(3) + hex(6) + hex(5));
  assert.equal(zkv1.c, "0x" + hex(7) + hex(8));
});

test("zkv1ToSnarkjs is the exact inverse of snarkjsToZkv1", () => {
  const roundTripped = snarkjsToZkv1(zkv1ToSnarkjs(snarkjsToZkv1(SAMPLE_SNARKJS)));
  assert.deepEqual(roundTripped, snarkjsToZkv1(SAMPLE_SNARKJS));
});

test("serialized bytes decode identically with the versioned header", () => {
  const proof = snarkjsToZkv1(SAMPLE_SNARKJS);
  const bytes = serializeProofBytes(proof);
  assert.equal(bytes.length, SERIALIZED_PROOF_LEN);
  assert.equal(bytes[0], PROOF_FORMAT_VERSION);
  assert.equal(bytes[1], 0); // BN254
  assert.deepEqual(deserializeProofBytes(bytes), { proof, curve: 0 });
});

test("a wrong version byte is rejected before any field is decoded", () => {
  const bytes = serializeProofBytes(snarkjsToZkv1(SAMPLE_SNARKJS));
  bytes[0] = PROOF_FORMAT_VERSION + 1;
  assert.throws(() => deserializeProofBytes(bytes), ProofFormatError);
});

test("public signals encode as 32-byte big-endian values in registry order", () => {
  assert.deepEqual(encodePublicSignalsBE(["1", "2", "0"]), [
    "0".repeat(63) + "1",
    "0".repeat(63) + "2",
    "0".repeat(64),
  ]);
});
