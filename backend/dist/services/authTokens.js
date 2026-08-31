/**
 * Auth Token Management Service
 *
 * Handles generation, validation, rotation, and lifecycle management for
 * per-client authentication tokens with secure hashing.
 */
import crypto from "crypto";
import { config } from "../config.js";
import { createLogger } from "./logger.js";
import { createAuthToken, getAuthTokenByHash, getAuthTokenById, getAllAuthTokens, getActiveAuthTokens, getValidAuthTokens, revokeAuthToken, markTokenRotated, recordTokenUsage, recordAuthAudit, expireAuthTokens, cleanupRevokedTokens, getTokensNeedingRotation, cleanupAuditLog, getAuditLog, getAuthTokensByClient, } from "./db.js";
const logger = createLogger("auth-tokens");
// ============================================
// TOKEN HASHING
// ============================================
const TOKEN_HASH_ALGO = "sha256";
function hashToken(rawToken) {
    return crypto.createHash(TOKEN_HASH_ALGO).update(rawToken).digest("hex");
}
// ============================================
// TOKEN GENERATION
// ============================================
function generateTokenId() {
    return `tok_${crypto.randomBytes(8).toString("hex")}`;
}
function generateRotationGroupId() {
    return `rot_${crypto.randomBytes(8).toString("hex")}`;
}
export function generateSecureToken(byteLength = 32) {
    return crypto.randomBytes(byteLength).toString("hex");
}
export function createTokenRecord(params) {
    const rawToken = generateSecureToken(32);
    const id = generateTokenId();
    const tokenHash = hashToken(rawToken);
    const now = Date.now();
    const expiresAt = params.lifetimeMs
        ? new Date(now + params.lifetimeMs).toISOString()
        : null;
    createAuthToken({
        id,
        tokenHash,
        clientId: params.clientId,
        description: params.description ?? null,
        expiresAt,
        rotationGroupId: params.rotationGroupId ?? null,
        isLegacy: params.isLegacy ?? false,
    });
    recordAuthAudit({
        tokenId: id,
        clientId: params.clientId,
        action: params.isLegacy ? "token_created_legacy_migrated" : "token_created",
        success: true,
    });
    logger.info("token_created", {
        tokenId: id,
        clientId: params.clientId,
        isLegacy: params.isLegacy ?? false,
        hasExpiration: !!expiresAt,
    });
    return {
        id,
        rawToken,
        clientId: params.clientId,
        description: params.description ?? null,
        expiresAt,
    };
}
// ============================================
// LEGACY TOKEN MIGRATION
// ============================================
const LEGACY_TOKEN_ID = "tok_legacy_env";
export function migrateLegacyToken() {
    const legacyToken = config.relayerAuthToken;
    if (!legacyToken)
        return;
    const existing = getAuthTokenById(LEGACY_TOKEN_ID);
    if (existing) {
        logger.debug("legacy_token_already_migrated");
        return;
    }
    const tokenHash = hashToken(legacyToken);
    const lifetimeMs = config.defaultTokenLifetimeMs;
    const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
    createAuthToken({
        id: LEGACY_TOKEN_ID,
        tokenHash,
        clientId: "legacy-client",
        description: "Legacy token migrated from RELAYER_AUTH_TOKEN env var",
        expiresAt,
        rotationGroupId: null,
        isLegacy: true,
    });
    recordAuthAudit({
        tokenId: LEGACY_TOKEN_ID,
        clientId: "legacy-client",
        action: "token_created_legacy_migrated",
        success: true,
    });
    logger.info("legacy_token_migrated", {
        tokenId: LEGACY_TOKEN_ID,
        expiresAt,
    });
}
export function validateToken(rawToken) {
    const tokenHash = hashToken(rawToken);
    const token = getAuthTokenByHash(tokenHash);
    if (!token) {
        return { valid: false, reason: "token_not_found" };
    }
    const now = Date.now();
    if (token.status === "revoked") {
        return { valid: false, reason: "token_revoked", token };
    }
    if (token.status === "expired") {
        return { valid: false, reason: "token_expired", token };
    }
    if (token.expiresAt && new Date(token.expiresAt).getTime() <= now) {
        return { valid: false, reason: "token_expired", token };
    }
    if (token.status === "rotating") {
        const transitionCutoff = now - config.tokenRotationTransitionMs;
        if (!token.revokedAt ||
            new Date(token.revokedAt).getTime() <= transitionCutoff) {
            return { valid: false, reason: "token_rotation_period_ended", token };
        }
    }
    return { valid: true, token };
}
export function markTokenUsed(tokenId, ipHash) {
    recordTokenUsage(tokenId, ipHash);
}
// ============================================
// TOKEN CRUD OPERATIONS
// ============================================
export function createNewToken(params) {
    if (!params.clientId || params.clientId.trim().length === 0) {
        throw new Error("clientId is required");
    }
    const result = createTokenRecord({
        clientId: params.clientId.trim(),
        description: params.description ?? null,
        lifetimeMs: params.lifetimeMs ?? config.defaultTokenLifetimeMs,
    });
    return result;
}
export function revokeToken(tokenId, revokedByClientId) {
    const token = getAuthTokenById(tokenId);
    if (!token) {
        logger.warn("token_revoke_not_found", { tokenId });
        return false;
    }
    if (token.status === "revoked" || token.status === "expired") {
        logger.warn("token_revoke_already_inactive", {
            tokenId,
            status: token.status,
        });
        return false;
    }
    revokeAuthToken(tokenId);
    recordAuthAudit({
        tokenId,
        clientId: revokedByClientId ?? null,
        action: "token_revoked",
        success: true,
    });
    logger.info("token_revoked", {
        tokenId,
        clientId: token.clientId,
        revokedBy: revokedByClientId ?? "unknown",
    });
    return true;
}
export function listTokens() {
    return getAllAuthTokens();
}
export function listActiveTokens() {
    return getActiveAuthTokens();
}
export function listTokensForClient(clientId) {
    return getAuthTokensByClient(clientId);
}
export function getToken(tokenId) {
    return getAuthTokenById(tokenId);
}
// ============================================
// TOKEN ROTATION
// ============================================
export function rotateSingleToken(oldToken) {
    if (oldToken.status !== "active") {
        logger.warn("token_rotate_not_active", {
            tokenId: oldToken.id,
            status: oldToken.status,
        });
        return null;
    }
    const rotationGroupId = oldToken.rotationGroupId ?? generateRotationGroupId();
    const newToken = createTokenRecord({
        clientId: oldToken.clientId,
        description: oldToken.description
            ? `${oldToken.description} (rotated)`
            : `Rotated token for ${oldToken.clientId}`,
        lifetimeMs: config.defaultTokenLifetimeMs,
        rotationGroupId,
    });
    markTokenRotated(oldToken.id, newToken.id);
    recordAuthAudit({
        tokenId: oldToken.id,
        clientId: oldToken.clientId,
        action: "token_rotated",
        success: true,
    });
    logger.info("token_rotated", {
        oldTokenId: oldToken.id,
        newTokenId: newToken.id,
        clientId: oldToken.clientId,
        rotationGroupId,
    });
    return newToken;
}
export function runTokenRotation() {
    if (!config.tokenRotationEnabled) {
        return [];
    }
    const tokensToRotate = getTokensNeedingRotation(config.tokenRotationIntervalMs);
    const results = [];
    for (const oldToken of tokensToRotate) {
        const newToken = rotateSingleToken(oldToken);
        if (newToken) {
            results.push({
                oldTokenId: oldToken.id,
                newTokenId: newToken.id,
                clientId: oldToken.clientId,
                rawToken: newToken.rawToken,
            });
        }
    }
    if (results.length > 0) {
        logger.info("token_rotation_run", { count: results.length });
    }
    return results;
}
// ============================================
// MAINTENANCE TASKS
// ============================================
export function runMaintenanceTasks() {
    const expiredCount = expireAuthTokens();
    if (expiredCount > 0) {
        logger.info("tokens_expired", { count: expiredCount });
    }
    const cleanedTokens = cleanupRevokedTokens();
    if (cleanedTokens > 0) {
        logger.info("revoked_tokens_cleaned", { count: cleanedTokens });
    }
    const cleanedAuditEntries = cleanupAuditLog();
    if (cleanedAuditEntries > 0) {
        logger.info("audit_log_cleaned", { count: cleanedAuditEntries });
    }
    const rotationResults = runTokenRotation();
    return {
        expiredCount,
        cleanedTokens,
        cleanedAuditEntries,
        rotatedCount: rotationResults.length,
    };
}
// ============================================
// VALID TOKENS FOR AUTH GUARD
// ============================================
export function getAllValidTokenHashes() {
    const validTokens = getValidAuthTokens(config.tokenRotationTransitionMs);
    const hashes = new Set();
    for (const token of validTokens) {
        hashes.add(token.tokenHash);
    }
    return hashes;
}
export function findTokenByRaw(rawToken) {
    const tokenHash = hashToken(rawToken);
    return getAuthTokenByHash(tokenHash);
}
// ============================================
// AUDIT LOG
// ============================================
export function getAuditEntries(options) {
    return getAuditLog(options);
}
export function logAuthAttempt(params) {
    if (!config.tokenAuditLogEnabled)
        return;
    recordAuthAudit({
        tokenId: params.tokenId ?? null,
        clientId: params.clientId ?? null,
        action: params.action,
        path: params.path ?? null,
        method: params.method ?? null,
        ipHash: params.ipHash ?? null,
        success: params.success,
        errorMessage: params.errorMessage ?? null,
    });
}
// ============================================
// MASTER KEY VALIDATION
// ============================================
export function validateMasterKey(rawKey) {
    if (!config.authMasterKey)
        return false;
    if (!rawKey)
        return false;
    const bufA = Buffer.from(rawKey);
    const bufB = Buffer.from(config.authMasterKey);
    if (bufA.length !== bufB.length) {
        const padded = Buffer.alloc(bufB.length);
        bufA.copy(padded);
        crypto.timingSafeEqual(padded, bufB);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}
//# sourceMappingURL=authTokens.js.map