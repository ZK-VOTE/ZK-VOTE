// @ts-nocheck
/**
 * Auth Token Management Routes
 *
 * Provides administrative endpoints for managing authentication tokens.
 * All endpoints require the AUTH_MASTER_KEY for access.
 */
import { Router } from "express";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { masterKeyGuard, validateBody, validateParams, validateQuery, bodyLimit, } from "../middleware/index.js";
import { createNewToken, revokeToken, listTokens, listActiveTokens, getToken, runTokenRotation, rotateSingleToken, runMaintenanceTasks, getAuditEntries, listTokensForClient, } from "../services/authTokens.js";
import { buildDidAttributeProofSeed, getBlindSignaturePublicKey, issueBlindSignature, } from "../services/blindSignature.js";
import { createTokenSchema, tokenIdSchema, clientIdQuerySchema, auditQuerySchema, didAttributeClaimSchema, } from "../validation/schemas.js";
const router = Router();
const blindSignatureIssuedForClient = new Set();
const blindSignatureAttempts = new Map();
function isBlindSignatureRateLimited(key) {
    const now = Date.now();
    const windowMs = 60_000;
    const maxAttempts = 5;
    const recent = (blindSignatureAttempts.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= maxAttempts) {
        return true;
    }
    recent.push(now);
    blindSignatureAttempts.set(key, recent);
    return false;
}
// ============================================
// TOKEN MANAGEMENT ENDPOINTS
// ============================================
/**
 * POST /auth/did-attribute-proof-seed - Prepare ZK attribute proof inputs
 * from an issuer-signed DID/eSIM claim.
 * Requires: AUTH_MASTER_KEY
 */
router.post("/auth/did-attribute-proof-seed", bodyLimit("100kb"), masterKeyGuard, validateBody(didAttributeClaimSchema), (async (req, res) => {
    const { claim, minAttributeValue } = req.body;
    try {
        const seed = buildDidAttributeProofSeed(claim, minAttributeValue);
        return res.status(200).json({
            success: true,
            seed,
        });
    }
    catch (err) {
        return res.status(400).json({
            success: false,
            error: err.message,
        });
    }
}));
/**
 * POST /auth/tokens - Create a new authentication token
 * Requires: AUTH_MASTER_KEY
 */
router.post("/auth/tokens", bodyLimit("100kb"), masterKeyGuard, validateBody(createTokenSchema), (async (req, res) => {
    const { clientId, description, lifetimeMs } = req.body;
    try {
        const token = createNewToken({
            clientId,
            description: description ?? null,
            lifetimeMs: lifetimeMs ?? config.defaultTokenLifetimeMs,
        });
        log("info", "token_created_api", {
            tokenId: token.id,
            clientId: token.clientId,
            hasExpiration: !!token.expiresAt,
        });
        return res.status(201).json({
            success: true,
            token: {
                id: token.id,
                rawToken: token.rawToken,
                clientId: token.clientId,
                description: token.description,
                expiresAt: token.expiresAt,
            },
        });
    }
    catch (err) {
        log("error", "token_create_failed", {
            error: err.message,
            clientId,
        });
        return res.status(400).json({
            success: false,
            error: err.message,
        });
    }
}));
/**
 * GET /auth/tokens - List all authentication tokens
 * Requires: AUTH_MASTER_KEY
 * Query params: clientId (optional filter), activeOnly (optional boolean)
 */
router.get("/auth/tokens", masterKeyGuard, validateQuery(clientIdQuerySchema), (async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { clientId, activeOnly } = req.validatedQuery;
    let tokens;
    if (clientId) {
        tokens = listTokensForClient(clientId);
    }
    else if (activeOnly) {
        tokens = listActiveTokens();
    }
    else {
        tokens = listTokens();
    }
    const safeTokens = tokens.map((t) => ({
        id: t.id,
        clientId: t.clientId,
        description: t.description,
        status: t.status,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
        lastUsedAt: t.lastUsedAt,
        useCount: t.useCount,
        rotationGroupId: t.rotationGroupId,
        isLegacy: t.isLegacy,
    }));
    return res.json({
        success: true,
        count: safeTokens.length,
        tokens: safeTokens,
    });
}));
/**
 * GET /auth/tokens/:tokenId - Get a specific token by ID
 * Requires: AUTH_MASTER_KEY
 */
router.get("/auth/tokens/:tokenId", masterKeyGuard, validateParams(tokenIdSchema), (async (req, res) => {
    const { tokenId } = req.params;
    const token = getToken(tokenId);
    if (!token) {
        return res.status(404).json({
            success: false,
            error: "Token not found",
        });
    }
    return res.json({
        success: true,
        token: {
            id: token.id,
            clientId: token.clientId,
            description: token.description,
            status: token.status,
            createdAt: token.createdAt,
            expiresAt: token.expiresAt,
            revokedAt: token.revokedAt,
            lastUsedAt: token.lastUsedAt,
            useCount: token.useCount,
            rotationGroupId: token.rotationGroupId,
            isLegacy: token.isLegacy,
        },
    });
}));
/**
 * POST /auth/tokens/:tokenId/revoke - Revoke a token
 * Requires: AUTH_MASTER_KEY
 */
router.post("/auth/tokens/:tokenId/revoke", bodyLimit("100kb"), masterKeyGuard, validateParams(tokenIdSchema), (async (req, res) => {
    const { tokenId } = req.params;
    const token = getToken(tokenId);
    if (!token) {
        return res.status(404).json({
            success: false,
            error: "Token not found",
        });
    }
    const revoked = revokeToken(tokenId);
    if (revoked) {
        return res.json({
            success: true,
            message: "Token revoked successfully",
            tokenId,
        });
    }
    else {
        return res.status(400).json({
            success: false,
            error: "Token is already revoked or expired",
            tokenId,
            currentStatus: token.status,
        });
    }
}));
/**
 * POST /auth/tokens/:tokenId/rotate - Rotate a specific token
 * Requires: AUTH_MASTER_KEY
 */
router.post("/auth/tokens/:tokenId/rotate", bodyLimit("100kb"), masterKeyGuard, validateParams(tokenIdSchema), (async (req, res) => {
    const { tokenId } = req.params;
    const oldToken = getToken(tokenId);
    if (!oldToken) {
        return res.status(404).json({
            success: false,
            error: "Token not found",
        });
    }
    const newToken = rotateSingleToken(oldToken);
    if (!newToken) {
        return res.status(400).json({
            success: false,
            error: "Token could not be rotated (must be active)",
            tokenId,
            currentStatus: oldToken.status,
        });
    }
    return res.status(201).json({
        success: true,
        message: "Token rotated successfully",
        oldTokenId: tokenId,
        newToken: {
            id: newToken.id,
            rawToken: newToken.rawToken,
            clientId: newToken.clientId,
            description: newToken.description,
            expiresAt: newToken.expiresAt,
        },
        transitionPeriodMs: config.tokenRotationTransitionMs,
    });
}));
/**
 * POST /auth/tokens/rotate - Run scheduled token rotation
 * Requires: AUTH_MASTER_KEY
 */
router.post("/auth/tokens/rotate", bodyLimit("100kb"), masterKeyGuard, (async (_req, res) => {
    if (!config.tokenRotationEnabled) {
        return res.status(400).json({
            success: false,
            error: "Token rotation is disabled via TOKEN_ROTATION_ENABLED=false",
        });
    }
    const results = runTokenRotation();
    return res.json({
        success: true,
        rotatedCount: results.length,
        rotatedTokens: results.map((r) => ({
            oldTokenId: r.oldTokenId,
            newTokenId: r.newTokenId,
            clientId: r.clientId,
            rawToken: r.rawToken,
        })),
        transitionPeriodMs: config.tokenRotationTransitionMs,
    });
}));
/**
 * POST /auth/maintenance - Run auth maintenance tasks
 * Requires: AUTH_MASTER_KEY
 */
router.post("/auth/maintenance", bodyLimit("100kb"), masterKeyGuard, (async (_req, res) => {
    const results = runMaintenanceTasks();
    log("info", "auth_maintenance_run", results);
    return res.json({
        success: true,
        ...results,
    });
}));
// ============================================
// AUDIT LOG ENDPOINTS
// ============================================
/**
 * GET /auth/audit - Get auth audit log entries
 * Requires: AUTH_MASTER_KEY
 * Query params: tokenId, clientId, action, limit, offset
 */
router.get("/auth/audit", masterKeyGuard, validateQuery(auditQuerySchema), (async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = req.validatedQuery;
    const entries = getAuditEntries({
        tokenId: options.tokenId,
        clientId: options.clientId,
        action: options.action,
        limit: options.limit,
        offset: options.offset,
    });
    return res.json({
        success: true,
        count: entries.length,
        entries: entries.map((e) => ({
            id: e.id,
            tokenId: e.tokenId,
            clientId: e.clientId,
            action: e.action,
            path: e.path,
            method: e.method,
            ipHash: e.ipHash,
            success: e.success,
            errorMessage: e.errorMessage,
            createdAt: e.createdAt,
        })),
    });
}));
// ============================================
// CONFIG ENDPOINT
// ============================================
/**
 * GET /auth/config - Get auth configuration
 * Requires: AUTH_MASTER_KEY
 */
router.get("/auth/config", masterKeyGuard, (_req, res) => {
    return res.json({
        success: true,
        config: {
            tokenRotationEnabled: config.tokenRotationEnabled,
            tokenRotationIntervalMs: config.tokenRotationIntervalMs,
            tokenRotationTransitionMs: config.tokenRotationTransitionMs,
            defaultTokenLifetimeMs: config.defaultTokenLifetimeMs,
            auditLogEnabled: config.tokenAuditLogEnabled,
        },
    });
});
/**
 * GET /auth/blind-signature/public-key - Get the RSA public key used for blind signing
 */
router.get("/auth/blind-signature/public-key", (async (_req, res) => {
    try {
        const publicKey = await getBlindSignaturePublicKey();
        return res.json({
            success: true,
            publicKey,
        });
    }
    catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
}));
/**
 * POST /auth/blind-signature/sign - Issue a blind signature on a blinded value.
 * Requires: AUTH_MASTER_KEY
 */
router.post("/auth/blind-signature/sign", bodyLimit("100kb"), masterKeyGuard, (async (req, res) => {
    const { clientId, blindedValue } = req.body;
    if (typeof clientId !== "string" || typeof blindedValue !== "string") {
        return res.status(400).json({
            success: false,
            error: "clientId and blindedValue are required",
        });
    }
    if (isBlindSignatureRateLimited(req.ip ?? "unknown")) {
        return res.status(429).json({
            success: false,
            error: "Blind signature rate limit exceeded",
        });
    }
    if (blindSignatureIssuedForClient.has(clientId)) {
        return res.status(409).json({
            success: false,
            error: "A blind signature has already been issued for this voter",
        });
    }
    try {
        const blindSignature = await issueBlindSignature({ clientId, blindedValue });
        blindSignatureIssuedForClient.add(clientId);
        log("info", "blind_signature_issued", { clientId });
        return res.status(201).json({
            success: true,
            blindSignature,
        });
    }
    catch (err) {
        log("error", "blind_signature_issue_failed", {
            error: err.message,
            clientId,
        });
        return res.status(400).json({
            success: false,
            error: err.message,
        });
    }
}));
export default router;
//# sourceMappingURL=auth.js.map