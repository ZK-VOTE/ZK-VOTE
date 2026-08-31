/**
 * Authentication Middleware
 *
 * Provides auth token verification for write endpoints.
 * Supports multiple per-client tokens with expiration, rotation, and audit logging.
 * Uses constant-time comparison to prevent timing attacks.
 */
import { timingSafeEqual } from "crypto";
import { config } from "../config.js";
import { log, hashIp } from "../services/logger.js";
import { validateToken, markTokenUsed, logAuthAttempt, migrateLegacyToken, } from "../services/authTokens.js";
let legacyMigrated = false;
function ensureLegacyMigrated() {
    if (!legacyMigrated) {
        try {
            migrateLegacyToken();
        }
        catch (err) {
            log("warn", "legacy_token_migration_failed", {
                error: err.message,
            });
        }
        legacyMigrated = true;
    }
}
/**
 * Extract auth token from request headers
 */
export function extractAuthToken(req) {
    const header = req.headers["x-relayer-auth"] || req.headers["authorization"];
    if (typeof header === "string" && header.startsWith("Bearer ")) {
        return header.slice("Bearer ".length);
    }
    return header;
}
/**
 * Extract client ID from request headers
 */
export function extractClientId(req) {
    const header = req.headers["x-client-id"];
    if (typeof header === "string" && header.length > 0) {
        return header;
    }
    return undefined;
}
/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if strings are equal, false otherwise.
 */
function safeCompare(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        const maxLen = Math.max(bufA.length, bufB.length);
        const paddedA = Buffer.alloc(maxLen);
        const paddedB = Buffer.alloc(maxLen);
        bufA.copy(paddedA);
        bufB.copy(paddedB);
        timingSafeEqual(paddedA, paddedB);
        return false;
    }
    return timingSafeEqual(bufA, bufB);
}
/**
 * Authentication guard for write endpoints
 * Validates tokens against database with expiration and revocation checks.
 * Supports graceful rotation where old tokens remain valid during transition.
 */
export function authGuard(req, res, next) {
    ensureLegacyMigrated();
    const rawToken = extractAuthToken(req);
    const clientIdHeader = extractClientId(req);
    const ipHash = config.logClientIp ? hashIp(req.ip) : null;
    if (!rawToken) {
        log("warn", "auth_failed", {
            path: req.path,
            reason: "missing_token",
        });
        logAuthAttempt({
            action: "auth_attempt",
            path: req.path,
            method: req.method,
            ipHash,
            success: false,
            errorMessage: "missing_token",
        });
        return res.status(401).json({ error: "Unauthorized" });
    }
    const validation = validateToken(rawToken);
    if (!validation.valid) {
        log("warn", "auth_failed", {
            path: req.path,
            reason: validation.reason,
            tokenId: validation.token?.id,
        });
        logAuthAttempt({
            tokenId: validation.token?.id,
            clientId: validation.token?.clientId,
            action: "auth_attempt",
            path: req.path,
            method: req.method,
            ipHash,
            success: false,
            errorMessage: validation.reason,
        });
        return res.status(401).json({ error: "Unauthorized" });
    }
    const token = validation.token;
    if (clientIdHeader && clientIdHeader !== token.clientId) {
        log("warn", "auth_failed", {
            path: req.path,
            reason: "client_id_mismatch",
            tokenId: token.id,
            tokenClientId: token.clientId,
            headerClientId: clientIdHeader,
        });
        logAuthAttempt({
            tokenId: token.id,
            clientId: token.clientId,
            action: "auth_attempt",
            path: req.path,
            method: req.method,
            ipHash,
            success: false,
            errorMessage: "client_id_mismatch",
        });
        return res.status(401).json({ error: "Unauthorized" });
    }
    try {
        markTokenUsed(token.id, ipHash);
    }
    catch (err) {
        log("warn", "auth_token_usage_record_failed", {
            tokenId: token.id,
            error: err.message,
        });
    }
    logAuthAttempt({
        tokenId: token.id,
        clientId: token.clientId,
        action: "auth_attempt",
        path: req.path,
        method: req.method,
        ipHash,
        success: true,
    });
    req.authToken = token;
    req.authClientId = token.clientId;
    req.authTokenId = token.id;
    next();
}
/**
 * Master key authentication guard for token management endpoints.
 * Uses the AUTH_MASTER_KEY environment variable.
 */
export function masterKeyGuard(req, res, next) {
    const header = req.headers["x-master-key"] || req.headers["authorization"];
    let masterKey;
    if (typeof header === "string") {
        if (header.startsWith("Bearer ")) {
            masterKey = header.slice("Bearer ".length);
        }
        else {
            masterKey = header;
        }
    }
    const ipHash = config.logClientIp ? hashIp(req.ip) : null;
    if (!masterKey) {
        log("warn", "master_key_auth_failed", {
            path: req.path,
            reason: "missing_master_key",
        });
        logAuthAttempt({
            action: "master_key_attempt",
            path: req.path,
            method: req.method,
            ipHash,
            success: false,
            errorMessage: "missing_master_key",
        });
        return res.status(401).json({ error: "Unauthorized" });
    }
    const expectedKey = config.authMasterKey;
    if (!expectedKey) {
        log("error", "master_key_not_configured", { path: req.path });
        return res.status(500).json({ error: "Server configuration error" });
    }
    if (!safeCompare(masterKey, expectedKey)) {
        log("warn", "master_key_auth_failed", {
            path: req.path,
            reason: "invalid_master_key",
        });
        logAuthAttempt({
            action: "master_key_attempt",
            path: req.path,
            method: req.method,
            ipHash,
            success: false,
            errorMessage: "invalid_master_key",
        });
        return res.status(401).json({ error: "Unauthorized" });
    }
    logAuthAttempt({
        action: "master_key_attempt",
        path: req.path,
        method: req.method,
        ipHash,
        success: true,
    });
    next();
}
//# sourceMappingURL=auth.js.map