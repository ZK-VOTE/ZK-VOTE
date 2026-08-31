/**
 * Authentication Middleware
 *
 * Provides auth token verification for write endpoints.
 * Supports multiple per-client tokens with expiration, rotation, and audit logging.
 * Uses constant-time comparison to prevent timing attacks.
 */

import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { config } from "../config.js";
import { log, hashIp } from "../services/logger.js";
import {
  validateToken,
  markTokenUsed,
  logAuthAttempt,
  migrateLegacyToken,
} from "../services/authTokens.js";
import { verifySignedSessionToken } from "../services/relaySessions.js";
import type { AuthToken } from "../services/db.js";

declare global {
  namespace Express {
    interface Request {
      authToken?: AuthToken;
      authClientId?: string;
      authTokenId?: string;
      isCoverTraffic?: boolean;
    }
  }
}

let legacyMigrated = false;

function ensureLegacyMigrated(): void {
  if (!legacyMigrated) {
    try {
      migrateLegacyToken();
    } catch (err) {
      log("warn", "legacy_token_migration_failed", {
        error: (err as Error).message,
      });
    }
    legacyMigrated = true;
  }
}

/**
 * Extract auth token from request headers
 */
export function extractAuthToken(req: Request): string | undefined {
  const header = req.headers["x-relayer-auth"] || req.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  return header as string | undefined;
}

/**
 * Extract client ID from request headers
 */
export function extractClientId(req: Request): string | undefined {
  const header = req.headers["x-client-id"];
  if (typeof header === "string" && header.length > 0) {
    return header;
  }
  return undefined;
}

export function extractSessionToken(req: Request): string | undefined {
  const header =
    req.headers["x-session-token"] ||
    req.headers["x-relay-session"] ||
    req.headers["x-relayer-session"] ||
    req.headers["authorization"];

  if (typeof header === "string") {
    if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
    if (header.startsWith("Session ")) return header.slice("Session ".length);
    return header;
  }

  return undefined;
}

export function extractDaoId(req: Request): number | undefined {
  const header =
    req.headers["x-dao-id"] || req.headers["x-dao"] || req.headers["dao-id"];

  if (typeof header !== "string") return undefined;
  const value = Number(header);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if strings are equal, false otherwise.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    const maxLen = Math.max(bufA.length, bufB.length);
    const paddedA = Buffer.alloc(maxLen);
    const paddedB = Buffer.alloc(maxLen);
    bufA.copy(paddedA);
    bufB.copy(paddedB);
    try {
      return timingSafeEqual(paddedA, paddedB);
    } catch {
      return false;
    }
  }

  return timingSafeEqual(bufAY, bufB);
}

/**
 * Authentication guard for write endpoints
 * Validates tokens against database with expiration and revocation checks.
 * Supports graceful rotation where old tokens remain valid during transition.
 */
export function authGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  ensureLegacyMigrated();

  const rawToken = extractAuthToken(req);
  const sessionToken = extractSessionToken(req);
  const clientIdHeader = extractClientId(req);
  const daoIdHeader = extractDaoId(req);
  const ipHash = config.logClientIp ? hashIp(req.ip) : null;

  if (!rawToken && !sessionToken) {
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

  const validation = rawToken
    ? validateToken(rawToken)
    : { valid: false, reason: "session_token_required" };
  let sessionValidation:
    | {
        valid: boolean;
        clientId?: string;
        daoId?: number;
        tokenId?: string;
        reason?: string;
      }
    | undefined;

  if (!validation.valid && sessionToken) {
    sessionValidation = verifySignedSessionToken(sessionToken, daoIdHeader);
  }

  if (!validation.valid && !sessionValidation?.valid) {
    log("warn", "auth_failed", {
      path: req.path,
      reason: validation.reason ?? sessionValidation?.reason ?? "invalid_token",
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
      errorMessage:
        validation.reason ?? sessionValidation?.reason ?? "invalid_token",
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

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

  const token = validation.valid ? validation.token! : undefined;
  const sessionClientId = sessionValidation?.clientId;
  const sessionDaoId = sessionValidation?.daoId;

  if (token && clientIdHeader && clientIdHeader !== token.clientId) {
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

  if (
    sessionValidation &&
    sessionClientId &&
    clientIdHeader &&
    clientIdHeader !== sessionClientId
  ) {
    log("warn", "auth_failed", {
      path: req.path,
      reason: "session_client_id_mismatch",
      tokenId: sessionValidation.tokenId,
      tokenClientId: sessionClientId,
      headerClientId: clientIdHeader,
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (
    sessionValidation &&
    daoIdHeader !== undefined &&
    sessionDaoId !== undefined &&
    daoIdHeader !== sessionDaoId
  ) {
    log("warn", "auth_failed", {
      path: req.path,
      reason: "dao_scope_mismatch",
      daoId: daoIdHeader,
      sessionDaoId,
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const authToken = token ?? undefined;
  const authClientId = token?.clientId ?? sessionClientId;
  const authTokenId = token?.id ?? sessionValidation?.tokenId;

  if (authToken) {
    try {
      markTokenUsed(authToken.id, ipHash);
    } catch (err) {
      log("warn", "auth_token_usage_record_failed", {
        tokenId: authToken.id,
        error: (err as Error).message,
      });
    }
  }

  logAuthAttempt({
    tokenId: authTokenId,
    clientId: authClientId,
    action: "auth_attempt",
    path: req.path,
    method: req.method,
    ipHash,
    success: true,
  });

  if (authToken) {
    req.authToken = authToken;
    req.authClientId = authClientId;
    req.authTokenId = authTokenId;
  } else if (sessionValidation?.valid && authClientId) {
    req.authClientId = authClientId;
    req.authTokenId = authTokenId;
    req.authToken = undefined;
  }

  next();
}

/**
 * Master key authentication guard for token management endpoints.
 * Uses the AUTH_MASTER_KEY environment variable.
 */
export function masterKeyGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  const header = req.headers["x-master-key"] || req.headers["authorization"];
  let masterKey: string | undefined;

  if (typeof header === "string") {
    if (header.startsWith("Bearer ")) {
      masterKey = header.slice("Bearer ".length);
    } else {
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

/**
 * Anonymous authentication guard for public submission endpoints.
 * Allows requests without an auth token, typical for cover traffic and
 * anonymous vote submission via the decentralized relay network.
 * If the request is identified as cover traffic via the x-cover-traffic
 * header, a flag is set on the request for downstream tally filtering.
 */
export function anonymousGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ipHash = config.logClientIp ? hashIp(req.ip) : null;
  const is.Cover = req.headers["x-cover-traffic"] === "true" || req.headers["x-cover-traffic"] === "1";

  // Store cover traffic flag for downstream processing
  req.isCoverTraffic = isCover;

  logAuthAttempt({
    action: isCover ? "cover_traffic_attempt" : "anonymous_attempt",
    path: req.path,
    method: req.method,
    ipHash,
    success: true,
  });

  next();
}
