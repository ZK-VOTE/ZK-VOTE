/**
 * Auth Token Management Routes
 *
 * Provides administrative endpoints for managing authentication tokens.
 * All endpoints require the AUTH_MASTER_KEY for access.
 */

import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import {
  masterKeyGuard,
  validateBody,
  validateParams,
  validateQuery,
  bodyLimit,
} from "../middleware/index.js";
import {
  createNewToken,
  revokeToken,
  listTokens,
  listActiveTokens,
  getToken,
  runTokenRotation,
  rotateSingleToken,
  runMaintenanceTasks,
  getAuditEntries,
  listTokensForClient,
} from "../services/authTokens.js";
import { buildDidAttributeProofSeed } from "../services/blindSignature.js";
import type { AsyncHandler } from "../types/index.js";
import {
  createTokenSchema,
  tokenIdSchema,
  clientIdQuerySchema,
  auditQuerySchema,
  didAttributeClaimSchema,
  type CreateTokenRequest,
  type DidAttributeClaimRequest,
  type TokenIdParams,
} from "../validation/schemas.js";

const router = Router();

// ============================================
// TOKEN MANAGEMENT ENDPOINTS
// ============================================

/**
 * POST /auth/did-attribute-proof-seed - Prepare ZK attribute proof inputs
 * from an issuer-signed DID/eSIM claim.
 * Requires: AUTH_MASTER_KEY
 */
router.post(
  "/auth/did-attribute-proof-seed",
  bodyLimit("100kb"),
  masterKeyGuard,
  validateBody(didAttributeClaimSchema),
  (async (req: Request, res: Response) => {
    const { claim, minAttributeValue } = req.body as DidAttributeClaimRequest;

    try {
      const seed = buildDidAttributeProofSeed(claim, minAttributeValue);
      return res.status(200).json({
        success: true,
        seed,
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: (err as Error).message,
      });
    }
  }) as AsyncHandler,
);

/**
 * POST /auth/tokens - Create a new authentication token
 * Requires: AUTH_MASTER_KEY
 */
router.post(
  "/auth/tokens",
  bodyLimit("100kb"),
  masterKeyGuard,
  validateBody(createTokenSchema),
  (async (req: Request, res: Response) => {
    const { clientId, description, lifetimeMs } =
      req.body as CreateTokenRequest;

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
    } catch (err) {
      log("error", "token_create_failed", {
        error: (err as Error).message,
        clientId,
      });
      return res.status(400).json({
        success: false,
        error: (err as Error).message,
      });
    }
  }) as AsyncHandler,
);

/**
 * GET /auth/tokens - List all authentication tokens
 * Requires: AUTH_MASTER_KEY
 * Query params: clientId (optional filter), activeOnly (optional boolean)
 */
router.get(
  "/auth/tokens",
  masterKeyGuard,
  validateQuery(clientIdQuerySchema),
  (async (req: Request, res: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { clientId, activeOnly } = (req as any).validatedQuery;

    let tokens;
    if (clientId) {
      tokens = listTokensForClient(clientId);
    } else if (activeOnly) {
      tokens = listActiveTokens();
    } else {
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
  }) as AsyncHandler,
);

/**
 * GET /auth/tokens/:tokenId - Get a specific token by ID
 * Requires: AUTH_MASTER_KEY
 */
router.get(
  "/auth/tokens/:tokenId",
  masterKeyGuard,
  validateParams(tokenIdSchema),
  (async (req: Request, res: Response) => {
    const { tokenId } = req.params as TokenIdParams;
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
  }) as AsyncHandler,
);

/**
 * POST /auth/tokens/:tokenId/revoke - Revoke a token
 * Requires: AUTH_MASTER_KEY
 */
router.post(
  "/auth/tokens/:tokenId/revoke",
  bodyLimit("100kb"),
  masterKeyGuard,
  validateParams(tokenIdSchema),
  (async (req: Request, res: Response) => {
    const { tokenId } = req.params as TokenIdParams;
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
    } else {
      return res.status(400).json({
        success: false,
        error: "Token is already revoked or expired",
        tokenId,
        currentStatus: token.status,
      });
    }
  }) as AsyncHandler,
);

/**
 * POST /auth/tokens/:tokenId/rotate - Rotate a specific token
 * Requires: AUTH_MASTER_KEY
 */
router.post(
  "/auth/tokens/:tokenId/rotate",
  bodyLimit("100kb"),
  masterKeyGuard,
  validateParams(tokenIdSchema),
  (async (req: Request, res: Response) => {
    const { tokenId } = req.params as TokenIdParams;
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
  }) as AsyncHandler,
);

/**
 * POST /auth/tokens/rotate - Run scheduled token rotation
 * Requires: AUTH_MASTER_KEY
 */
router.post("/auth/tokens/rotate", bodyLimit("100kb"), masterKeyGuard, (async (
  _req: Request,
  res: Response,
) => {
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
}) as AsyncHandler);

/**
 * POST /auth/maintenance - Run auth maintenance tasks
 * Requires: AUTH_MASTER_KEY
 */
router.post("/auth/maintenance", bodyLimit("100kb"), masterKeyGuard, (async (
  _req: Request,
  res: Response,
) => {
  const results = runMaintenanceTasks();

  log("info", "auth_maintenance_run", results);

  return res.json({
    success: true,
    ...results,
  });
}) as AsyncHandler);

// ============================================
// AUDIT LOG ENDPOINTS
// ============================================

/**
 * GET /auth/audit - Get auth audit log entries
 * Requires: AUTH_MASTER_KEY
 * Query params: tokenId, clientId, action, limit, offset
 */
router.get(
  "/auth/audit",
  masterKeyGuard,
  validateQuery(auditQuerySchema),
  (async (req: Request, res: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = (req as any).validatedQuery;

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
  }) as AsyncHandler,
);

// ============================================
// CONFIG ENDPOINT
// ============================================

/**
 * GET /auth/config - Get auth configuration
 * Requires: AUTH_MASTER_KEY
 */
router.get("/auth/config", masterKeyGuard, (_req: Request, res: Response) => {
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
