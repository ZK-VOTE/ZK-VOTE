import test from "node:test";

// Wire refactored services for tests: since #358 services receive their
// dependencies via init*() instead of importing module globals, tests must
// perform the same wiring the production composition root does at boot.
import { buildAppServices } from "../src/composition-root.js";
buildAppServices();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dataDir = path.resolve("data");
const DEFAULT_DB = path.join(dataDir, "zkvote.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

async function resetDb() {
  try {
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
  } catch {}
  try { fs.unlinkSync(DEFAULT_DB); } catch {}
}

function countLeadingZeroBits(buf) {
  let count = 0;
  for (const byte of buf) {
    if (byte === 0) {
      count += 8;
    } else {
      count += Math.clz32(byte) - 24;
      break;
    }
  }
  return count;
}

function solvePow(challenge, commitment, difficulty) {
  let nonce = 0n;
  const maxAttempts = 5000000;
  while (nonce < maxAttempts) {
    const workNonce = nonce.toString(16).padStart(16, "0");
    const payload = challenge + commitment + workNonce;
    const hash = crypto.createHash("sha256").update(payload).digest();
    if (countLeadingZeroBits(hash) >= difficulty) {
      return workNonce;
    }
    nonce++;
  }
  return null;
}

test("PoW challenge generation and verification", async () => {
  const { generateChallenge, verifyChallenge, cleanupExpiredChallenges } = await import("../src/services/pow.js");

  const config = { difficulty: 8, challengeTtlMs: 30000 };
  const commitment = "0x" + "ab".repeat(32);

  const challenge = generateChallenge(commitment, config);
  assert.ok(challenge.serverId);
  assert.equal(challenge.difficulty, 8);
  assert.ok(challenge.expiresAt > Date.now());
  assert.equal(challenge.consumed, false);

  const workNonce = solvePow(challenge.serverId, commitment, 8);
  assert.ok(workNonce, "Should find a valid nonce");

  const result = verifyChallenge(challenge.serverId, commitment, workNonce, config);
  assert.equal(result.valid, true);

  const reused = verifyChallenge(challenge.serverId, commitment, workNonce, config);
  assert.equal(reused.valid, false);
  assert.equal(reused.reason, "Challenge already consumed");

  cleanupExpiredChallenges();
});

test("PoW rejects expired challenge", async () => {
  const { generateChallenge, verifyChallenge, cleanupExpiredChallenges } = await import("../src/services/pow.js");

  const config = { difficulty: 1, challengeTtlMs: -1 };
  const commitment = "0x" + "cd".repeat(32);

  const challenge = generateChallenge(commitment, config);

  const workNonce = solvePow(challenge.serverId, commitment, 1);
  assert.ok(workNonce);

  const result = verifyChallenge(challenge.serverId, commitment, workNonce, config);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "Challenge expired");

  cleanupExpiredChallenges();
});

test("PoW rejects wrong commitment", async () => {
  const { generateChallenge, verifyChallenge, cleanupExpiredChallenges } = await import("../src/services/pow.js");

  const config = { difficulty: 1, challengeTtlMs: 30000 };

  const challenge = generateChallenge("0xaa", config);

  const workNonce = solvePow(challenge.serverId, "0xbb", 1);
  assert.ok(workNonce);

  const result = verifyChallenge(challenge.serverId, "0xbb", workNonce, config);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "Commitment mismatch");

  cleanupExpiredChallenges();
});

test("PoW rejects insufficient work", async () => {
  const { generateChallenge, verifyChallenge, cleanupExpiredChallenges } = await import("../src/services/pow.js");

  const config = { difficulty: 20, challengeTtlMs: 30000 };
  const commitment = "0x" + "ef".repeat(32);

  const challenge = generateChallenge(commitment, config);

  const result = verifyChallenge(challenge.serverId, commitment, "0000000000000000", config);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("Insufficient PoW"));

  cleanupExpiredChallenges();
});

test("PoW rejects non-existent challenge", async () => {
  const { verifyChallenge } = await import("../src/services/pow.js");

  const config = { difficulty: 1, challengeTtlMs: 30000 };
  const result = verifyChallenge("nonexistent", "0x00", "0000000000000000", config);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "Challenge not found or expired");
});

test("challenge count tracks active challenges", async () => {
  const { generateChallenge, getChallengeCount, cleanupExpiredChallenges } = await import("../src/services/pow.js");

  const config = { difficulty: 1, challengeTtlMs: 30000 };

  const count1 = getChallengeCount();
  generateChallenge("0xaa", config);
  generateChallenge("0xbb", config);
  const count2 = getChallengeCount();
  assert.equal(count2, count1 + 2);

  cleanupExpiredChallenges();
  assert.equal(getChallengeCount(), 0);
});

test("per-commitment rate limiting blocks excessive comments", async () => {
  resetDb();
  const { initDb, closeDb } = await import("../src/services/db.js");
  initDb();
  const { checkCommitmentRateLimit, recordCommentSubmission } = await import("../src/services/anti-spam.js");

  const commitment = "0x" + "12".repeat(32);
  const daoId = 1;
  const proposalId = 1;
  const maxPerWindow = 3;
  const windowMs = 60000;

  for (let i = 0; i < maxPerWindow; i++) {
    assert.ok(checkCommitmentRateLimit(commitment, daoId, proposalId, maxPerWindow, windowMs),
      `Attempt ${i + 1} should be allowed`);
    recordCommentSubmission(commitment, daoId, proposalId, windowMs);
  }

  assert.equal(
    checkCommitmentRateLimit(commitment, daoId, proposalId, maxPerWindow, windowMs),
    false,
    "Attempt after limit should be blocked",
  );

  closeDb();
});

test("rate limiting is per-commitment", async () => {
  resetDb();
  const { initDb, closeDb } = await import("../src/services/db.js");
  initDb();
  const { checkCommitmentRateLimit, recordCommentSubmission } = await import("../src/services/anti-spam.js");

  const commitmentA = "0x" + "aa".repeat(32);
  const commitmentB = "0x" + "bb".repeat(32);
  const maxPerWindow = 1;
  const windowMs = 60000;

  assert.ok(checkCommitmentRateLimit(commitmentA, 1, 1, maxPerWindow, windowMs));
  recordCommentSubmission(commitmentA, 1, 1, windowMs);

  assert.equal(checkCommitmentRateLimit(commitmentA, 1, 1, maxPerWindow, windowMs), false);

  assert.ok(checkCommitmentRateLimit(commitmentB, 1, 1, maxPerWindow, windowMs),
    "Different commitment should not be rate limited");

  closeDb();
});

test("committed rate limit is per-dao and per-proposal", async () => {
  resetDb();
  const { initDb, closeDb } = await import("../src/services/db.js");
  initDb();
  const { checkCommitmentRateLimit, recordCommentSubmission } = await import("../src/services/anti-spam.js");

  const commitment = "0x" + "ff".repeat(32);
  const maxPerWindow = 1;
  const windowMs = 60000;

  assert.ok(checkCommitmentRateLimit(commitment, 1, 1, maxPerWindow, windowMs));
  recordCommentSubmission(commitment, 1, 1, windowMs);

  assert.equal(checkCommitmentRateLimit(commitment, 1, 1, maxPerWindow, windowMs), false);

  assert.ok(checkCommitmentRateLimit(commitment, 2, 1, maxPerWindow, windowMs),
    "Different DAO should be allowed");

  assert.ok(checkCommitmentRateLimit(commitment, 1, 2, maxPerWindow, windowMs),
    "Different proposal should be allowed");

  closeDb();
});

test("flagging a comment records it", async () => {
  resetDb();
  const { initDb, closeDb } = await import("../src/services/db.js");
  initDb();
  const { flagComment, getFlagStatus } = await import("../src/services/anti-spam.js");

  const result = flagComment(1, 1, 1, "0xcommitment1", "0xnullifier1", 3);
  assert.equal(result.success, true);
  assert.equal(result.hidden, false);
  assert.equal(result.flagCount, 1);

  const status = getFlagStatus(1, 1, 1);
  assert.equal(status.flagged, true);
  assert.equal(status.hidden, false);
  assert.equal(status.flagCount, 1);

  closeDb();
});

test("duplicate flag by same nullifier is rejected", async () => {
  resetDb();
  const { initDb, closeDb } = await import("../src/services/db.js");
  initDb();
  const { flagComment } = await import("../src/services/anti-spam.js");

  const r1 = flagComment(1, 1, 1, "0xcommitment1", "0xnullifier1", 3);
  assert.equal(r1.success, true);

  const r2 = flagComment(1, 1, 1, "0xcommitment1", "0xnullifier1", 3);
  assert.equal(r2.success, false);

  closeDb();
});

test("auto-hide after threshold flags", async () => {
  resetDb();
  const { initDb, closeDb } = await import("../src/services/db.js");
  initDb();
  const { flagComment, getFlagStatus } = await import("../src/services/anti-spam.js");

  const threshold = 3;

  const r1 = flagComment(1, 1, 1, "0xcomm1", "0xnull1", threshold);
  assert.equal(r1.hidden, false);

  const r2 = flagComment(1, 1, 1, "0xcomm2", "0xnull2", threshold);
  assert.equal(r2.hidden, false);

  const r3 = flagComment(1, 1, 1, "0xcomm3", "0xnull3", threshold);
  assert.equal(r3.hidden, true);

  const status = getFlagStatus(1, 1, 1);
  assert.equal(status.flagged, true);
  assert.equal(status.hidden, true);
  assert.equal(status.flagCount, 3);

  closeDb();
});

test("getHiddenCommentIds returns hidden comments", async () => {
  resetDb();
  const { initDb, closeDb } = await import("../src/services/db.js");
  initDb();
  const { flagComment, getHiddenCommentIds } = await import("../src/services/anti-spam.js");

  flagComment(1, 1, 1, "0xca", "0xna", 1);
  flagComment(2, 1, 1, "0xcb", "0xnb", 1);

  const hidden = getHiddenCommentIds(1, 1);
  assert.ok(hidden.includes(1));
  assert.ok(hidden.includes(2));
  assert.equal(hidden.length, 2);

  closeDb();
});
