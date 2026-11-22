import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// #918 — challenges must be consumable exactly once, expire, and reject replays.
const pow = await import("../src/services/pow.js");

const CONFIG = { difficulty: 0, challengeTtlMs: 60_000 };

test("memory store: consume succeeds exactly once", () => {
  const store = pow.createMemoryPowStore();
  store.put({
    serverId: "a",
    commitment: "c",
    difficulty: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    consumed: false,
  });
  assert.equal(store.consume("a", Date.now()), true);
  assert.equal(store.consume("a", Date.now()), false);
});

test("memory store: expired challenges cannot be consumed", () => {
  const store = pow.createMemoryPowStore();
  store.put({
    serverId: "b",
    commitment: "c",
    difficulty: 0,
    createdAt: 0,
    expiresAt: 1,
    consumed: false,
  });
  assert.equal(store.consume("b", 2), false);
});

test("verifyChallenge rejects replay of a solved challenge", () => {
  const commitment = "0x" + crypto.randomBytes(32).toString("hex");
  const challenge = pow.generateChallenge(commitment, CONFIG);
  const nonce = "1";
  const first = pow.verifyChallenge(challenge.serverId, commitment, nonce, CONFIG);
  const second = pow.verifyChallenge(challenge.serverId, commitment, nonce, CONFIG);
  assert.equal(first.valid, true);
  assert.equal(second.valid, false);
  assert.match(second.reason, /consumed/);
});

test("verifyChallenge rejects unknown challenge ids", () => {
  const result = pow.verifyChallenge("does-not-exist", "c", "1", CONFIG);
  assert.equal(result.valid, false);
});

test("verifyChallenge rejects commitment mismatch without consuming", () => {
  const commitment = "0x" + crypto.randomBytes(32).toString("hex");
  const challenge = pow.generateChallenge(commitment, CONFIG);
  const bad = pow.verifyChallenge(challenge.serverId, "0xother", "1", CONFIG);
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /mismatch/);
  const good = pow.verifyChallenge(challenge.serverId, commitment, "1", CONFIG);
  assert.equal(good.valid, true);
});
