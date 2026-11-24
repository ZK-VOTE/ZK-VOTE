/**
 * Persisted VDF ordering: restart replay, late-share rejection, verification
 * from stored inputs and immutable commit records.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";

const DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-randomness-"));
const DB_PATH = path.join(DIR, "randomness.db");

const { initDb } = await import("../src/services/db.js");
const db = initDb(DB_PATH) as never;
const { RandomnessStore, OrderingCommittedError } = await import(
  "../src/services/randomness-store.js"
);
const { computeVdf, deriveVdfInput, verifyVdf } = await import(
  "../src/services/vdf.js"
);

test.after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

function seedState(store: InstanceType<typeof RandomnessStore>, daoId: number) {
  const input = deriveVdfInput(
    daoId,
    10,
    "a".repeat(64),
    "b".repeat(64),
  );
  const { output, checkpoints } = computeVdf(input, 500);
  const proposalIds = [10, 20, 30, 40];
  const replayNonce = crypto
    .createHash("sha256")
    .update(Buffer.concat([
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(BigInt(daoId));
        return b;
      })(),
      Buffer.from(proposalIds.join(",")),
      Buffer.from(output, "hex"),
    ]))
    .digest("hex");
  return store.create({
    daoId,
    vdfInput: input,
    vdfOutput: output,
    vdfCheckpoints: checkpoints,
    vdfIterations: 500,
    proposalIds,
    requiredShares: 2,
    replayNonce,
  });
}

function finalize(store: InstanceType<typeof RandomnessStore>, daoId: number) {
  return store.finalize({
    daoId,
    compute: (state) => {
      const combined = state.shares
        .map((s) => Buffer.from(s.shareHex, "hex"))
        .reduce(
          (acc, share) =>
            Buffer.from(acc.map((b, i) => b ^ share[i])),
          Buffer.alloc(32),
        );
      const seed = crypto
        .createHash("sha256")
        .update(Buffer.from(state.vdfOutput, "hex"))
        .update(combined)
        .digest("hex");
      return { combinedSeed: seed, ordering: [...state.proposalIds].reverse() };
    },
  });
}

test("finalized ordering is identical after a restart (new store instance)", () => {
  const store = new RandomnessStore(db as never);
  const state = seedState(store, 101);
  store.addShare({ daoId: 101, authorityId: "auth-a", shareHex: "11".repeat(32) });
  store.addShare({ daoId: 101, authorityId: "auth-b", shareHex: "22".repeat(32) });
  const finalized = finalize(store, 101);
  assert.equal(finalized.committed, true);

  // Fresh instance models a restarted process or a different replica.
  const restarted = new RandomnessStore(db as never);
  const reloaded = restarted.get(101)!;
  assert.deepEqual(reloaded.ordering, finalized.ordering);
  assert.equal(reloaded.combinedSeed, finalized.combinedSeed);
  assert.equal(reloaded.shares.length, 2);
  assert.equal(
    verifyVdf(
      reloaded.vdfInput,
      reloaded.vdfIterations,
      reloaded.vdfOutput,
      reloaded.vdfCheckpoints,
    ),
    true,
  );
});

test("late threshold shares cannot mutate a committed ordering", () => {
  const store = new RandomnessStore(db as never);
  seedState(store, 102);
  store.addShare({ daoId: 102, authorityId: "auth-a", shareHex: "55".repeat(32) });
  store.addShare({ daoId: 102, authorityId: "auth-b", shareHex: "66".repeat(32) });
  finalize(store, 102);
  const before = store.get(102)!;
  assert.throws(
    () =>
      store.addShare({
        daoId: 102,
        authorityId: "late-authority",
        shareHex: "33".repeat(32),
      }),
    OrderingCommittedError,
  );
  assert.equal(store.get(102)!.shares.length, before.shares.length);
  assert.deepEqual(store.get(102)!.ordering, before.ordering);
});

test("duplicate authority submissions are idempotent", () => {
  const store = new RandomnessStore(db as never);
  seedState(store, 103);
  const first = store.addShare({
    daoId: 103,
    authorityId: "auth-a",
    shareHex: "44".repeat(32),
  });
  const duplicate = store.addShare({
    daoId: 103,
    authorityId: "auth-a",
    shareHex: "ff".repeat(32),
  });
  assert.equal(first.added, true);
  assert.equal(duplicate.added, false);
  assert.equal(store.get(103)!.shares[0].shareHex, "44".repeat(32));
});

test("immutable commit record matches persisted inputs and rejects mutation", () => {
  const store = new RandomnessStore(db as never);
  const commit = store.getCommitRecord(101)!;
  const recomputed = crypto
    .createHash("sha256")
    .update(JSON.stringify(commit.payload))
    .digest("hex");
  assert.equal(commit.payloadHash, recomputed);
  const payload = commit.payload as { authoritySet: string[] };
  assert.deepEqual(payload.authoritySet.sort(), ["auth-a", "auth-b"]);

  const database = db as unknown as {
    prepare(sql: string): { run(...p: unknown[]): unknown };
  };
  assert.throws(() =>
    database
      .prepare("UPDATE randomness_commits SET recorded_at = 0 WHERE dao_id = 101")
      .run(),
  );
});
