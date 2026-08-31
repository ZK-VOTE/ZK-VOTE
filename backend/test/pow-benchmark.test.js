import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

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

function solvePow(serverId, commitment, difficulty, maxAttempts = 5000000) {
  const startTime = performance.now();
  let attempts = 0;
  for (let nonce = 0n; nonce < maxAttempts; nonce++) {
    const workNonce = nonce.toString(16).padStart(16, "0");
    const payload = serverId + commitment + workNonce;
    const hash = crypto.createHash("sha256").update(payload).digest();
    if (countLeadingZeroBits(hash) >= difficulty) {
      return { workNonce, attempts: nonce + 1n, timeMs: performance.now() - startTime };
    }
  }
  return null;
}

test("PoW benchmark: measure solve time at various difficulties", async () => {
  const commitment = "0x" + "ab".repeat(32);
  const difficulties = [8, 12, 16, 18, 20];
  const results = [];

  for (const diff of difficulties) {
    const serverId = crypto.randomBytes(32).toString("hex");
    const startAll = performance.now();
    let totalAttempts = 0n;
    const samples = diff <= 12 ? 5 : 3;

    for (let s = 0; s < samples; s++) {
      const sid = crypto.randomBytes(32).toString("hex");
      const result = solvePow(sid, commitment, diff);
      if (result) {
        totalAttempts += result.attempts;
      }
    }

    const elapsed = (performance.now() - startAll) / 1000;
    const avgAttempts = Number(totalAttempts) / samples;
    const avgTimePerSample = (elapsed / samples) * 1000;

    results.push({
      difficulty: diff,
      avgTimeMs: avgTimePerSample,
      avgAttempts: Math.round(avgAttempts),
      estimatedCommentsPerMin: (60000 / avgTimePerSample).toFixed(1),
    });

    console.log(
      `  diff=${diff}  avg=${avgTimePerSample.toFixed(1)}ms  ` +
      `attempts=${Math.round(avgAttempts)}  ` +
      `est.comments/min=${results[results.length-1].estimatedCommentsPerMin}`,
    );
  }

  assert.ok(results.length > 0);
  assert.ok(results[0].avgTimeMs < results[4].avgTimeMs, "Higher difficulty should take longer");
});

test("PoW benchmark: max throughput at difficulty 20", async () => {
  const commitment = "0x" + "cd".repeat(32);
  const serverId = crypto.randomBytes(32).toString("hex");

  const startTime = performance.now();
  const result = solvePow(serverId, commitment, 20, 20000000);

  if (result) {
    const hashRate = Number(result.attempts) / (result.timeMs / 1000);
    console.log(
      `  diff=20: solved in ${result.timeMs.toFixed(0)}ms, ` +
      `${Number(result.attempts)} attempts, ` +
      `${(hashRate / 1000).toFixed(0)}K hashes/s`,
    );
    console.log(`  estimated comments/min at diff=20: ${(60000 / result.timeMs).toFixed(1)}`);
    assert.ok(result.timeMs > 0);
  } else {
    console.log("  diff=20: not solved within 20M attempts (expected on slow hardware)");
  }
});

test("PoW benchmark: theoretical adversarial spam rate", () => {
  const hashesPerSecond = 500_000;
  const difficulties = [8, 12, 16, 20, 24];

  for (const diff of difficulties) {
    const expectedAttempts = 2 ** diff;
    const avgTimeMs = (expectedAttempts / hashesPerSecond) * 1000;
    const commentsPerMin = 60000 / Math.max(avgTimeMs, 0.001);

    // adjust for multiple concurrent workers
    const concurrentWorkers = 4;
    const adversarialPerMin = commentsPerMin * concurrentWorkers;

    console.log(
      `  diff=${diff}: ` +
      `~${expectedAttempts} attempts expected, ` +
      `~${avgTimeMs.toFixed(0)}ms/comment (1 core), ` +
      `~${adversarialPerMin.toFixed(0)}/min (${concurrentWorkers} cores)`,
    );
  }

  assert.ok(true);
});

test("PoW benchmark: rate limit interaction", async () => {
  const commitment = "0x" + "ef".repeat(32);
  const serverId = crypto.randomBytes(32).toString("hex");

  const powResult = solvePow(serverId, commitment, 12);
  assert.ok(powResult, "Should solve diff 12");

  const avgTimeMs = powResult.timeMs;

  // With rate limit of 5/min, an attacker needs to solve PoW 5 times
  const totalTimeFor5Comments = avgTimeMs * 5;
  const canSubmit5InWindow = totalTimeFor5Comments < 60000;

  console.log(
    `  diff=12: ${avgTimeMs.toFixed(0)}ms/comment, ` +
    `${totalTimeFor5Comments.toFixed(0)}ms for 5 comments, ` +
    `within 60s window: ${canSubmit5InWindow}`,
  );

  // combined barrier: PoW cost + rate limit
  // attacker with single commitment can submit at most N/min,
  // each requiring PoW solve
  assert.ok(powResult.workNonce.length > 0);
});

test("spam resistance: simulated adversarial submission", async () => {
  const { generateChallenge, verifyChallenge, cleanupExpiredChallenges } =
    await import("../src/services/pow.js");

  const powConfig = { difficulty: 8, challengeTtlMs: 60000 };
  const commitments = [];
  for (let i = 0; i < 10; i++) {
    commitments.push("0x" + crypto.randomBytes(32).toString("hex"));
  }

  // Simulate: spammer tries to submit 10 comments as fast as possible
  let solved = 0;
  let failed = 0;
  const startTime = performance.now();

  for (const comm of commitments) {
    const challenge = generateChallenge(comm, powConfig);
    const result = solvePow(challenge.serverId, comm, 8);
    if (result) {
      const verify = verifyChallenge(challenge.serverId, comm, result.workNonce, powConfig);
      if (verify.valid) {
        solved++;
      } else {
        failed++;
      }
    } else {
      failed++;
    }
  }

  const elapsed = (performance.now() - startTime) / 1000;
  console.log(
    `  simulated 10 submissions at diff=8: ${solved} solved, ` +
    `${failed} failed in ${elapsed.toFixed(1)}s`,
  );

  // all should solve at diff 8
  assert.equal(solved, 10);
  assert.equal(failed, 0);

  cleanupExpiredChallenges();
});

test("spam resistance: multiple concurrent commitments", async () => {
  const { generateChallenge, verifyChallenge, getChallengeCount, cleanupExpiredChallenges } =
    await import("../src/services/pow.js");

  const powConfig = { difficulty: 10, challengeTtlMs: 30000 };
  const numConcurrent = 20;

  // generate many challenges (attacker pre-fetches challenges)
  for (let i = 0; i < numConcurrent; i++) {
    generateChallenge("0x" + crypto.randomBytes(32).toString("hex"), powConfig);
  }

  assert.equal(getChallengeCount(), numConcurrent);

  // verify they exist and try to solve
  let solvedCount = 0;
  const startAll = performance.now();

  // We'll re-use POW solver but this is just a stress test
  // of challenge management, not full solve
  const results = [];
  for (let i = 0; i < Math.min(numConcurrent, 5); i++) {
    const comm = "0x" + crypto.randomBytes(32).toString("hex");
    const challenge = generateChallenge(comm, powConfig);
    const powResult = solvePow(challenge.serverId, comm, 10);
    if (powResult) {
      const verify = verifyChallenge(challenge.serverId, comm, powResult.workNonce, powConfig);
      if (verify.valid) solvedCount++;
      results.push(powResult.timeMs);
    }
  }

  const avgSolve = results.length > 0
    ? results.reduce((a, b) => a + b, 0) / results.length
    : 0;
  console.log(
    `  concurrent challenges: ${numConcurrent} generated, ` +
    `${solvedCount} solved, avg time: ${avgSolve.toFixed(0)}ms`,
  );

  assert.equal(solvedCount, 5);
  cleanupExpiredChallenges();
  assert.equal(getChallengeCount(), 0);
});

test("spam resistance: flag spam prevention", async () => {
  const { initDb, closeDb } = await import("../src/services/db.js");
  const { flagComment, getFlagStatus, getHiddenCommentIds } =
    await import("../src/services/anti-spam.js");

  try { closeDb(); } catch {}
  try { const fs = await import("node:fs"); fs.unlinkSync("data/zkvote.db"); } catch {}

  initDb();

  // anti-spam is DI-migrated (#358) — wire it with the real singletons the
  // same way the composition root does (kysely is lazy over getDb()).
  const { getDb } = await import("../src/services/db.js");
  const { kysely } = await import("../src/services/kysely.js");
  const { logger } = await import("../src/services/logger.js");
  const { initAntiSpam } = await import("../src/services/anti-spam.js");
  initAntiSpam({ getDb, kysely, logger });

  const daoId = 1;
  const proposalId = 1;
  const threshold = 3;

  // simulate: spammer tries to flag a good comment 10 times with different nullifiers
  let hidden = false;
  for (let i = 0; i < 10; i++) {
    const result = flagComment(
      42, daoId, proposalId,
      "0xcommitment_spammer",
      "0xnullifier_" + i,
      threshold,
    );
    if (result.hidden) hidden = true;
  }

  const status = getFlagStatus(42, daoId, proposalId);
  assert.equal(status.flagCount, 10, "All 10 unique flags should be counted");

  // first 3 flags hide it; after that the comment stays hidden
  assert.equal(hidden, true, "Comment should be hidden after threshold");
  assert.equal(status.hidden, true, "getFlagStatus should report hidden");

  const hiddenIds = getHiddenCommentIds(daoId, proposalId);
  assert.ok(hiddenIds.includes(42), "Hidden comment should appear in list");

  closeDb();
});
