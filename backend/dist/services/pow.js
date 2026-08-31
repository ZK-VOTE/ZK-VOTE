import crypto from "crypto";
import { log } from "./logger.js";
const CHALLENGES = new Map();
const CLEANUP_INTERVAL_MS = 60_000;
let cleanupTimer = null;
function startCleanup() {
    if (cleanupTimer)
        return;
    cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, challenge] of CHALLENGES) {
            if (now > challenge.expiresAt) {
                CHALLENGES.delete(id);
            }
        }
    }, CLEANUP_INTERVAL_MS);
    if (cleanupTimer &&
        typeof cleanupTimer === "object" &&
        "unref" in cleanupTimer) {
        cleanupTimer.unref();
    }
}
export function generateChallenge(commitment, config) {
    const serverId = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const challenge = {
        serverId,
        commitment,
        difficulty: config.difficulty,
        createdAt: now,
        expiresAt: now + config.challengeTtlMs,
        consumed: false,
    };
    CHALLENGES.set(serverId, challenge);
    startCleanup();
    log("info", "pow_challenge_generated", {
        commitment: commitment.slice(0, 16),
        difficulty: config.difficulty,
    });
    return challenge;
}
export function verifyChallenge(serverId, commitment, workNonce, config) {
    const challenge = CHALLENGES.get(serverId);
    if (!challenge) {
        return { valid: false, reason: "Challenge not found or expired" };
    }
    if (challenge.consumed) {
        return { valid: false, reason: "Challenge already consumed" };
    }
    if (Date.now() > challenge.expiresAt) {
        CHALLENGES.delete(serverId);
        return { valid: false, reason: "Challenge expired" };
    }
    if (challenge.commitment !== commitment) {
        return { valid: false, reason: "Commitment mismatch" };
    }
    const payload = serverId + commitment + workNonce;
    const hash = crypto.createHash("sha256").update(payload).digest();
    const leadingBits = countLeadingZeroBits(hash);
    if (leadingBits < config.difficulty) {
        return {
            valid: false,
            reason: `Insufficient PoW: got ${leadingBits} leading bits, need ${config.difficulty}`,
        };
    }
    challenge.consumed = true;
    log("info", "pow_challenge_verified", {
        commitment: commitment.slice(0, 16),
        leadingBits,
    });
    return { valid: true };
}
export function cleanupExpiredChallenges() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
    CHALLENGES.clear();
}
export function getChallengeCount() {
    return CHALLENGES.size;
}
function countLeadingZeroBits(buf) {
    let count = 0;
    for (const byte of buf) {
        if (byte === 0) {
            count += 8;
        }
        else {
            count += Math.clz32(byte) - 24;
            break;
        }
    }
    return count;
}
//# sourceMappingURL=pow.js.map