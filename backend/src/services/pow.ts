import crypto from "crypto";
import { Counter, register } from "prom-client";
import { log } from "./logger.js";

// ============================================
// METRICS (#918)
// ============================================

const powChallengesIssued = new Counter({
  name: "zkvote_pow_challenges_issued_total",
  help: "PoW challenges issued",
  registers: [register],
});

const powChallengesSolved = new Counter({
  name: "zkvote_pow_challenges_solved_total",
  help: "PoW challenges verified and consumed",
  registers: [register],
});

const powChallengesRejected = new Counter({
  name: "zkvote_pow_challenges_rejected_total",
  help: "PoW verification attempts rejected",
  labelNames: ["reason"] as const,
  registers: [register],
});

const powChallengesExpired = new Counter({
  name: "zkvote_pow_challenges_expired_total",
  help: "PoW challenges removed after expiry",
  registers: [register],
});

// ============================================
// TYPES
// ============================================

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

/**
 * Store for outstanding PoW challenges.
 *
 * `consume` must be atomic: it returns true for exactly one caller per
 * challenge. A shared implementation (e.g. a database row updated with
 * `UPDATE ... WHERE consumed = 0`) lets a challenge issued by one replica be
 * consumed exactly once on another. The default in-process store is only
 * correct for a single replica.
 */
export interface PowChallengeStore {
  put(challenge: PowChallenge): void;
  get(serverId: string): PowChallenge | undefined;
  consume(serverId: string, now: number): boolean;
  deleteExpired(now: number): number;
  clear(): void;
  size(): number;
}

// ============================================
// IN-PROCESS STORE
// ============================================

export function createMemoryPowStore(): PowChallengeStore {
  const challenges = new Map<string, PowChallenge>();
  return {
    put(challenge) {
      challenges.set(challenge.serverId, challenge);
    },
    get(serverId) {
      return challenges.get(serverId);
    },
    consume(serverId, now) {
      const challenge = challenges.get(serverId);
      if (!challenge || challenge.consumed || now > challenge.expiresAt) {
        return false;
      }
      // Synchronous check-and-set: no await between read and write.
      challenge.consumed = true;
      return true;
    },
    deleteExpired(now) {
      let removed = 0;
      for (const [id, challenge] of challenges) {
        if (now > challenge.expiresAt) {
          challenges.delete(id);
          removed++;
        }
      }
      return removed;
    },
    clear() {
      challenges.clear();
    },
    size() {
      return challenges.size;
    },
  };
}

let store: PowChallengeStore = createMemoryPowStore();
const CLEANUP_INTERVAL_MS = 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Replace the challenge store (e.g. with a shared implementation). */
export function setPowChallengeStore(next: PowChallengeStore): void {
  store = next;
}

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const removed = store.deleteExpired(Date.now());
    if (removed > 0) powChallengesExpired.inc(removed);
  }, CLEANUP_INTERVAL_MS);
  if (
    cleanupTimer &&
    typeof cleanupTimer === "object" &&
    "unref" in cleanupTimer
  ) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }
}

// ============================================
// PUBLIC API
// ============================================

export function generateChallenge(
  commitment: string,
  config: PowConfig,
): PowChallenge {
  const serverId = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const challenge: PowChallenge = {
    serverId,
    commitment,
    difficulty: config.difficulty,
    createdAt: now,
    expiresAt: now + config.challengeTtlMs,
    consumed: false,
  };
  store.put(challenge);
  powChallengesIssued.inc();
  startCleanup();
  log("info", "pow_challenge_generated", {
    commitment: commitment.slice(0, 16),
    difficulty: config.difficulty,
  });
  return challenge;
}

export function verifyChallenge(
  serverId: string,
  commitment: string,
  workNonce: string,
  config: PowConfig,
): { valid: boolean; reason?: string } {
  const challenge = store.get(serverId);
  if (!challenge) {
    powChallengesRejected.inc({ reason: "not_found" });
    return { valid: false, reason: "Challenge not found or expired" };
  }

  if (challenge.consumed) {
    powChallengesRejected.inc({ reason: "consumed" });
    return { valid: false, reason: "Challenge already consumed" };
  }

  if (Date.now() > challenge.expiresAt) {
    store.deleteExpired(Date.now());
    powChallengesRejected.inc({ reason: "expired" });
    return { valid: false, reason: "Challenge expired" };
  }

  if (challenge.commitment !== commitment) {
    powChallengesRejected.inc({ reason: "commitment_mismatch" });
    return { valid: false, reason: "Commitment mismatch" };
  }

  const payload = serverId + commitment + workNonce;
  const hash = crypto.createHash("sha256").update(payload).digest();
  const leadingBits = countLeadingZeroBits(hash);

  if (leadingBits < config.difficulty) {
    powChallengesRejected.inc({ reason: "insufficient_work" });
    return {
      valid: false,
      reason: `Insufficient PoW: got ${leadingBits} leading bits, need ${config.difficulty}`,
    };
  }

  // Atomic consume: if a concurrent verifier won the race, reject.
  if (!store.consume(serverId, Date.now())) {
    powChallengesRejected.inc({ reason: "consumed" });
    return { valid: false, reason: "Challenge already consumed" };
  }

  powChallengesSolved.inc();
  log("info", "pow_challenge_verified", {
    commitment: commitment.slice(0, 16),
    leadingBits,
  });
  return { valid: true };
}

export function cleanupExpiredChallenges(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  store.clear();
}

export function getChallengeCount(): number {
  return store.size();
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
