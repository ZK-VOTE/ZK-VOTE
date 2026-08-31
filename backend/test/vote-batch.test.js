/**
 * Unit coverage for the batched-vote submission path (#90).
 *
 * These exercise the schema and the ScVal encoding directly rather than
 * through HTTP: `csrfTokenMiddleware` is never mounted, so no client can
 * obtain a CSRF token and every write endpoint answers 403 before a handler
 * runs. Driving the route over supertest would therefore assert nothing about
 * the batch logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";

const { voteBatchSchema, MAX_VOTE_BATCH } = await import(
  "../src/validation/schemas.ts"
);
const { batchVoteToScVal } = await import("../src/services/stellar.ts");

const FIELD = "0x" + "11".repeat(32);
// Every coordinate must be a valid Fq element, i.e. below the BN254 base
// field modulus p = 0x3064..., so the filler byte has to stay under 0x30.
const proof = () => ({
  a: "0x" + "22".repeat(64),
  b: "0x" + "11".repeat(128),
  c: "0x" + "22".repeat(64),
});
const nth = (i) => "0x" + i.toString(16).padStart(64, "0");
const vote = (nullifier) => ({
  choice: true,
  nullifier,
  root: FIELD,
  proof: proof(),
});
const batch = (votes) => ({ daoId: 1, proposalId: 1, votes });

test("MAX_VOTE_BATCH matches the contract's MAX_BATCH_SIZE", async () => {
  const fs = await import("fs");
  const src = fs.readFileSync(
    new URL("../../contracts/zkvote-groth16/src/batch.rs", import.meta.url),
    "utf8",
  );
  const m = src.match(/pub const MAX_BATCH_SIZE: u32 = (\d+);/);
  assert.ok(m, "MAX_BATCH_SIZE not found in the batch verifier");
  assert.equal(Number(m[1]), MAX_VOTE_BATCH);
});

test("an empty batch is rejected", () => {
  const r = voteBatchSchema.safeParse(batch([]));
  assert.equal(r.success, false);
});

test("a batch at exactly the maximum is accepted", () => {
  const votes = Array.from({ length: MAX_VOTE_BATCH }, (_, i) => vote(nth(i + 1)));
  const r = voteBatchSchema.safeParse(batch(votes));
  assert.equal(r.success, true);
});

test("a batch one over the maximum is rejected", () => {
  const votes = Array.from({ length: MAX_VOTE_BATCH + 1 }, (_, i) =>
    vote(nth(i + 1)),
  );
  const r = voteBatchSchema.safeParse(batch(votes));
  assert.equal(r.success, false);
});

// The contract panics on a repeated nullifier: its storage check only sees
// committed state, so both copies would be written in the same transaction.
// Rejecting here avoids spending a simulation to learn that.
test("a duplicate nullifier inside the batch is rejected", () => {
  const dup = nth(7);
  const r = voteBatchSchema.safeParse(batch([vote(dup), vote(dup)]));
  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.error.issues), /duplicate nullifier/i);
});

test("distinct nullifiers are accepted", () => {
  const r = voteBatchSchema.safeParse(batch([vote(nth(1)), vote(nth(2))]));
  assert.equal(r.success, true);
});

test("a proof coordinate at or above the base field modulus is rejected", () => {
  const bad = vote(nth(1));
  bad.proof.a = "0x" + "ff".repeat(64);
  assert.equal(voteBatchSchema.safeParse(batch([bad])).success, false);
});

test("a proof component with non-hex characters is rejected", () => {
  const bad = vote(nth(1));
  bad.proof.c = "0xzz" + "22".repeat(63);
  assert.equal(voteBatchSchema.safeParse(batch([bad])).success, false);
});

test("a nullifier outside the BN254 scalar field is rejected", () => {
  const bad = vote("0x" + "ff".repeat(32));
  assert.equal(voteBatchSchema.safeParse(batch([bad])).success, false);
});

// A #[contracttype] struct crosses as an ScMap whose keys must be sorted; an
// unsorted map is rejected by the host, so the order is asserted rather than
// left to the order the fields happen to be written in.
test("BatchVote encodes as a map with sorted symbol keys", () => {
  const sv = batchVoteToScVal(vote(nth(3)));
  assert.equal(sv.switch().name, "scvMap");
  const keys = sv.map().map((e) => e.key().sym().toString());
  assert.deepEqual(keys, ["nullifier", "proof", "root", "vote_choice"]);
  assert.deepEqual(keys, [...keys].sort());
});

test("BatchVote carries the choice through as a bool", () => {
  const yes = batchVoteToScVal({ ...vote(nth(1)), choice: true });
  const no = batchVoteToScVal({ ...vote(nth(1)), choice: false });
  const choiceOf = (sv) =>
    sv.map().find((e) => e.key().sym().toString() === "vote_choice").val().b();
  assert.equal(choiceOf(yes), true);
  assert.equal(choiceOf(no), false);
});

test("a batch encodes as a vector of one entry per vote", () => {
  const votes = [vote(nth(1)), vote(nth(2)), vote(nth(3))];
  const vec = StellarSdk.xdr.ScVal.scvVec(votes.map(batchVoteToScVal));
  assert.equal(vec.switch().name, "scvVec");
  assert.equal(vec.vec().length, 3);
});

test("an invalid proof is rejected at encode time, not silently passed on", () => {
  const bad = vote(nth(1));
  bad.proof.a = "0x" + "00".repeat(64);
  assert.throws(() => batchVoteToScVal(bad), /point at infinity/);
});

// The chain enforces BN254_FR_MODULUS; a backend bound that disagrees either
// rejects legitimate votes or waves through ones the contract will panic on.
// This was wrong by a factor of 99 (two digits dropped from the decimal
// literal), which rejected ~99% of valid nullifiers.
test("the signal bound matches the contract's BN254_FR_MODULUS", async () => {
  const fs = await import("fs");
  const { BN254_SCALAR_FIELD, BN254_MODULUS } = await import(
    "../src/config.ts"
  );

  const src = fs.readFileSync(
    new URL("../../contracts/zkvote-groth16/src/lib.rs", import.meta.url),
    "utf8",
  );
  const block = src.match(
    /pub const BN254_FR_MODULUS: \[u8; 32\] = \[([^\]]+)\]/,
  );
  assert.ok(block, "BN254_FR_MODULUS not found in the verifier");
  const bytes = block[1].match(/0x[0-9a-fA-F]{2}/g).map((b) => b.slice(2));
  assert.equal(bytes.length, 32);

  assert.equal(BN254_SCALAR_FIELD, BigInt("0x" + bytes.join("")));
  // r < p: the scalar field is the group order, the base field is larger.
  assert.ok(BN254_SCALAR_FIELD < BN254_MODULUS);
});

test("a nullifier just below the scalar field modulus is accepted", async () => {
  const { BN254_SCALAR_FIELD } = await import("../src/config.ts");
  const justUnder = "0x" + (BN254_SCALAR_FIELD - 1n).toString(16).padStart(64, "0");
  const r = voteBatchSchema.safeParse(batch([vote(justUnder)]));
  assert.equal(r.success, true);
});

test("a nullifier at the scalar field modulus is rejected", async () => {
  const { BN254_SCALAR_FIELD } = await import("../src/config.ts");
  const atModulus = "0x" + BN254_SCALAR_FIELD.toString(16).padStart(64, "0");
  const r = voteBatchSchema.safeParse(batch([vote(atModulus)]));
  assert.equal(r.success, false);
});
