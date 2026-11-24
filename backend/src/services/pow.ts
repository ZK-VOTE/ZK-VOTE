import crypto from "crypto";
import { log } from "./logger.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { Counter, register } from "prom-client";

// ── Prometheus metrics ──────────────────────────────────────────────────────
const powIssued = new Counter({
  name: "zkvote_pow_challenges_issued_total",
  help: "PoW challenges generated",
  registers: [register],
});
const powSolved = new Counter({
  name: "zkvote_pow_challenges_solved_total",
  help: "PoW challenges successfully verified and consumed",
  registers: [register],
});
const powExpired = new Counter({
  name: "zkvote_pow_challenges_expired_total",
  help: "PoW challenges that expired before consumption",
  registers: [register],
});
const powRejected = new Counter({
  name: "zkvote_pow_challenges_rejected_total",
  help: "PoW challenge verifications that failed",
  labelNames: ["reason"],
  registers: [register],
});

// ── Database wiring ─────────────────────────────────────────────────────────
let _db: DatabaseType | null = null;

/**
 * Register the shared database. Must be called during application boot before
 * any challenge is generated or verified — the in-process Map is gone (#918).
 */
export function setPowDatabase(db: DatabaseType): void {
  _db = db;
}

function getDb(): DatabaseType {
  if (!_db) {
    throw new Error(
      "pow: database not initialised — call setPowDatabase(db) during boot",
    );
  }
  return _db;
}

// ── Types ───────────────────────────────────────────────────────────────────
export interface PowChallenge {
  serverId: string;
  commitment: string;
  difficulty: number;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export interface PowConfig {
  difficulty: number;
  challengeTtlMs: number;
}

// ── Challenge lifecycle ──────────────────────────────────────────────────────

/**
 * Generate a new challenge bound to `commitment` and store it in the shared DB
 * so any replica can verify it (#918 acceptance criterion 1).
 */
export function generateChallenge(
  commitment: string,
  config: PowConfig,
): PowChallenge {
  const serverId = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = now + config.challengeTtlMs;

  getDb()
    .prepare(
      `INSERT INTO pow_challenges (server_id, commitment, difficulty, created_at, expires_at, consumed)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(serverId, commitment, config.difficulty, now, expiresAt);

  powIssued.inc();
  log("info", "pow_challenge_generated", {
    commitment: commitment.slice(0, 16),
    difficulty: config.difficulty,
  });

  return { serverId, commitment, difficulty: config.difficulty, createdAt: now, expiresAt, consumed: false };
}

/**
 * Verify a challenge response.  The consumed flag is toggled atomically in a
 * single UPDATE so two concurrent replicas cannot both succeed on the same
 * challenge (#918 acceptance criterion 1 — consume exactly once).
 */
export function verifyChallenge(
  serverId: string,
  commitment: string,
  workNonce: string,
  config: PowConfig,
): { valid: boolean; reason?: string } {
  const db = getDb();
  const now = Date.now();

  const row = db
    .prepare(`SELECT * FROM pow_challenges WHERE server_id = ?`)
    .get(serverId) as (PowChallenge & { consumed: number | boolean }) | undefined;

  if (!row) {
    powRejected.inc({ reason: "not_found" });
    return { valid: false, reason: "Challenge not found or expired" };
  }

  if (row.consumed === 1 || row.consumed === true) {
    powRejected.inc({ reason: "already_consumed" });
    return { valid: false, reason: "Challenge already consumed" };
  }

  if (now > row.expiresAt) {
    db.prepare(`DELETE FROM pow_challenges WHERE server_id = ?`).run(serverId);
    powExpired.inc();
    powRejected.inc({ reason: "expired" });
    return { valid: false, reason: "Challenge expired" };
  }

  if (row.commitment !== commitment) {
    powRejected.inc({ reason: "commitment_mismatch" });
    return { valid: false, reason: "Commitment mismatch" };
  }

  const payload = serverId + commitment + workNonce;
  const hash = crypto.createHash("sha256").update(payload).digest();
  const leadingBits = countLeadingZeroBits(hash);

  if (leadingBits < config.difficulty) {
    powRejected.inc({ reason: "insufficient_pow" });
    return {
      valid: false,
      reason: `Insufficient PoW: got ${leadingBits} leading bits, need ${config.difficulty}`,
    };
  }

  // Atomic consume: UPDATE WHERE consumed = 0 — only one replica wins
  const result = db
    .prepare(
      `UPDATE pow_challenges SET consumed = 1 WHERE server_id = ? AND consumed = 0`,
    )
    .run(serverId) as { changes: number };

  if (result.changes === 0) {
    // Another replica consumed it between our SELECT and this UPDATE
    powRejected.inc({ reason: "race_consumed" });
    return { valid: false, reason: "Challenge already consumed" };
  }

  powSolved.inc();
  log("info", "pow_challenge_verified", {
    commitment: commitment.slice(0, 16),
    leadingBits,
  });
  return { valid: true };
}

/**
 * Delete all expired and consumed challenges.  Safe to call from any replica;
 * idempotent.
 */
export function cleanupExpiredChallenges(): number {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `DELETE FROM pow_challenges WHERE expires_at < ? OR consumed = 1`,
    )
    .run(now) as { changes: number };
  return result.changes;
}

/** For health checks / tests. */
export function getChallengeCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM pow_challenges WHERE consumed = 0`)
    .get() as { n: number };
  return row.n;
}

function countLeadingZeroBits(buf: Buffer): number {
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
