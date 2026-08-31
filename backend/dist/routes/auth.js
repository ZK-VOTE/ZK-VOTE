/**
 * Auth Token Management Routes
 *
 * Provides administrative endpoints for managing authentication tokens.
 * All endpoints require the AUTH_MASTER_KEY for access.
 */
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { masterKeyGuard, validateBody, validateParams, bodyLimit, } from "../middleware/index.js";
import { createNewToken, revokeToken, listTokens, listActiveTokens, getToken, runTokenRotation, rotateSingleToken, runMaintenanceTasks, getAuditEntries, listTokensForClient, } from "../services/authTokens.js";
import { buildDidAttributeProofSeed } from "../services/blindSignature.js";
const router = Router();
// ============================================
// SCHEMAS
// ============================================
const createTokenSchema = z.object({
    clientId: z.string().min(1).max(100),
    description: z.string().max(500).optional().nullable(),
    lifetimeMs: z.number().int().positive().optional().nullable(),
});
const tokenIdSchema = z.object({
    tokenId: z.string().min(1),
});
const clientIdQuerySchema = z.object({
    clientId: z.string().min(1).optional(),
    activeOnly: z
        .union([z.string(), z.boolean()])
        .optional()
        .transform((v) => v === "true" || v === true),
});
const auditQuerySchema = z.object({
    tokenId: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    limit: z
        .union([z.string(), z.number()])
        .optional()
        .transform((v) => Math.min(Number(v) || 100, 1000)),
    offset: z
        .union([z.string(), z.number()])
        .optional()
        .transform((v) => Math.max(Number(v) || 0, 0)),
});
const didAttributeClaimSchema = z.object({
    claim: z.object({
        issuer: z.string().min(1).max(256),
        subjectDid: z.string().min(1).max(512),
        attributeKey: z.string().min(1).max(128),
        attributeValue: z.number().int().nonnegative(),
        issuedAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().nonnegative(),
        signature: z.string().min(1).max(4096),
    }),
    minAttributeValue: z.number().int().nonnegative(),
});
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
router.get("/auth/tokens", masterKeyGuard, (async (req, res) => {
    const parsed = clientIdQuerySchema.safeParse(req.query);
    const { clientId, activeOnly } = parsed.success ? parsed.data : {};
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
router.get("/auth/audit", masterKeyGuard, (async (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    const options = (parsed.success ? parsed.data : {});
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
export default router;
//# sourceMappingURL=auth.js.map