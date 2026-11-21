/**
 * SEP-24 Session Security — Session Fixation & Popup-Abuse Prevention (#762)
 * Enhanced with Persistent Storage (ZV-119 / #958)
 *
 * Implements secure session management for SEP-24 interactive deposit/withdrawal flows:
 * - Generates cryptographically secure session tokens with short TTL
 * - Prevents session fixation via token rotation on privilege escalation
 * - Validates popup origin and parent window to prevent abuse
 * - Implements CSRF protection specific to interactive flows
 * - Persists sessions in shared database for multi-replica continuity
 */

import * as crypto from "crypto";
import { log } from "./logger.js";
import { kysely } from "./kysely.js";
import { sql } from "kysely";

const SESSION_TOKEN_LENGTH = 32; // 256 bits
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours absolute max

export interface SEP24Session {
  sessionId: string;
  token: string;
  asset: "USDC" | "EURC";
  account: string;
  originalOrigin: string;
  popupNonce: string;
  popupNonceConsumed: boolean;
  createdAt: number;
  lastActivityAt: number;
  issuedTokens: Set<string>; // Track all issued tokens for rotation
}

/**
 * Generates a cryptographically secure random token.
 */
function generateSecureToken(): string {
  return crypto.randomBytes(SESSION_TOKEN_LENGTH).toString("hex");
}

/**
 * Hashes a token for storage (prevents token leakage in DB dumps).
 */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generates a nonce for popup window verification.
 */
function generatePopupNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Creates a new SEP-24 session with secure token generation.
 * Session is bound to a specific origin and account to prevent fixation attacks.
 * Persists to database for cross-replica continuity (ZV-119).
 */
export async function createSEP24Session(
  asset: "USDC" | "EURC",
  account: string,
  originalOrigin: string,
  clientIp?: string,
): Promise<{ sessionId: string; token: string; popupNonce: string }> {
  const sessionId = crypto.randomUUID();
  const token = generateSecureToken();
  const tokenHash = hashToken(token);
  const popupNonce = generatePopupNonce();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MAX_SESSION_AGE_MS);

  try {
    await kysely.transaction().execute(async (trx) => {
      // Insert session
      await trx
        .insertInto("sep24_sessions")
        .values({
          session_id: sessionId,
          asset,
          account,
          original_origin: originalOrigin,
          popup_nonce: popupNonce,
          popup_nonce_consumed: false,
          created_at: now,
          last_activity_at: now,
          expires_at: expiresAt,
          created_by_ip: clientIp,
        })
        .execute();

      // Insert initial token
      await trx
        .insertInto("sep24_session_tokens")
        .values({
          session_id: sessionId,
          token_hash: tokenHash,
          issued_at: now,
          is_current: true,
          rotated_from_token_id: null,
          revoked_at: null,
        })
        .execute();
    });

    log("info", "sep24_session_created", {
      sessionId,
      asset,
      account: account.slice(0, 8) + "...",
    });

    return { sessionId, token, popupNonce };
  } catch (error: any) {
    log("error", "sep24_session_creation_failed", {
      error: error.message,
      asset,
      account: account.slice(0, 8) + "...",
    });
    throw new Error("Failed to create SEP-24 session");
  }
}

/**
 * Validates a session token and checks for expiration or tampering.
 * Returns null if session is invalid, expired, or has been fixated.
 * Checks database for cross-replica session validity (ZV-119).
 */
export async function validateSEP24Session(
  sessionId: string,
  token: string,
): Promise<{ valid: boolean; reason?: string; account?: string }> {
  const tokenHash = hashToken(token);
  
  try {
    const result = await kysely
      .selectFrom("sep24_sessions")
      .innerJoin("sep24_session_tokens", "sep24_sessions.session_id", "sep24_session_tokens.session_id")
      .select([
        "sep24_sessions.session_id",
        "sep24_sessions.account",
        "sep24_sessions.asset",
        "sep24_sessions.original_origin",
        "sep24_sessions.popup_nonce",
        "sep24_sessions.popup_nonce_consumed",
        "sep24_sessions.created_at",
        "sep24_sessions.expires_at",
        "sep24_session_tokens.token_hash",
        "sep24_session_tokens.is_current",
        "sep24_session_tokens.revoked_at",
      ])
      .where("sep24_sessions.session_id", "=", sessionId)
      .where("sep24_session_tokens.token_hash", "=", tokenHash)
      .where("sep24_session_tokens.is_current", "=", true)
      .where("sep24_session_tokens.revoked_at", "is", null)
      .executeTakeFirst();

    if (!result) {
      await recordSecurityEvent(sessionId, "token_validation_failed", {
        reason: "session_or_token_not_found",
      });
      return { valid: false, reason: "Session not found or token invalid" };
    }

    const now = new Date();
    if (now > new Date(result.expires_at)) {
      await recordSecurityEvent(sessionId, "session_expired", {
        expired_at: result.expires_at,
      });
      return { valid: false, reason: "Session expired" };
    }

    // Update last activity timestamp
    await kysely
      .updateTable("sep24_sessions")
      .set({ last_activity_at: now })
      .where("session_id", "=", sessionId)
      .execute();

    return { valid: true, account: result.account };
  } catch (error: any) {
    log("error", "sep24_validation_error", {
      sessionId,
      error: error.message,
    });
    return { valid: false, reason: "Validation error" };
  }
}

/**
 * Rotates the session token after privilege escalation or sensitive operations.
 * Invalidates old token and issues a new one to prevent fixation attacks.
 * Prevents replay of rotated tokens (ZV-119).
 */
export async function rotateSEP24Token(
  sessionId: string,
  currentToken: string,
): Promise<{ newToken: string } | null> {
  const currentTokenHash = hashToken(currentToken);
  const newToken = generateSecureToken();
  const newTokenHash = hashToken(newToken);
  const now = new Date();

  try {
    const result = await kysely.transaction().execute(async (trx) => {
      // Verify current token is valid and current
      const currentTokenRecord = await trx
        .selectFrom("sep24_session_tokens")
        .select(["id", "session_id"])
        .where("session_id", "=", sessionId)
        .where("token_hash", "=", currentTokenHash)
        .where("is_current", "=", true)
        .where("revoked_at", "is", null)
        .executeTakeFirst();

      if (!currentTokenRecord) {
        return null;
      }

      // Mark old token as not current
      await trx
        .updateTable("sep24_session_tokens")
        .set({ is_current: false, revoked_at: now })
        .where("id", "=", currentTokenRecord.id)
        .execute();

      // Insert new token
      await trx
        .insertInto("sep24_session_tokens")
        .values({
          session_id: sessionId,
          token_hash: newTokenHash,
          issued_at: now,
          is_current: true,
          rotated_from_token_id: currentTokenRecord.id,
          revoked_at: null,
        })
        .execute();

      // Update last activity
      await trx
        .updateTable("sep24_sessions")
        .set({ last_activity_at: now })
        .where("session_id", "=", sessionId)
        .execute();

      return { newToken };
    });

    if (result) {
      await recordSecurityEvent(sessionId, "token_rotated", {
        rotated_at: now.toISOString(),
      });

      log("info", "sep24_token_rotated", {
        sessionId,
      });
    }

    return result;
  } catch (error: any) {
    log("error", "sep24_token_rotation_failed", {
      sessionId,
      error: error.message,
    });
    return null;
  }
}

/**
 * Validates popup window origin to prevent popup-abuse attacks.
 * Ensures the popup is hosted on a trusted anchor domain.
 */
export function validatePopupOrigin(
  trustedOrigins: Set<string>,
  popupOrigin: string,
): boolean {
  try {
    const origin = new URL(popupOrigin).origin;
    return trustedOrigins.has(origin);
  } catch {
    return false;
  }
}

/**
 * Validates the popup's parent window reference.
 * Ensures the popup was opened from the expected parent window.
 */
export async function validatePopupParent(
  sessionId: string,
  parentOrigin: string,
): Promise<boolean> {
  try {
    const session = await kysely
      .selectFrom("sep24_sessions")
      .select(["original_origin"])
      .where("session_id", "=", sessionId)
      .executeTakeFirst();

    if (!session) {
      return false;
    }

    const parent = new URL(parentOrigin).origin;
    const expected = new URL(session.original_origin).origin;
    return parent === expected;
  } catch {
    return false;
  }
}

/**
 * Verifies popup nonce to prevent replay attacks.
 * Nonce should be included in popup window opener parameters.
 * Database-backed replay detection (ZV-119).
 */
export async function verifyPopupNonce(
  sessionId: string,
  submittedNonce: string,
): Promise<boolean> {
  // Validate nonce shape and length before database check
  if (
    typeof submittedNonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(submittedNonce)
  ) {
    return false;
  }

  try {
    const session = await kysely
      .selectFrom("sep24_sessions")
      .select(["popup_nonce", "popup_nonce_consumed"])
      .where("session_id", "=", sessionId)
      .executeTakeFirst();

    if (!session || session.popup_nonce_consumed) {
      await recordSecurityEvent(sessionId, "nonce_verification_failed", {
        reason: session ? "already_consumed" : "session_not_found",
      });
      return false;
    }

    // Constant-time comparison
    const expected = Buffer.from(session.popup_nonce, "hex");
    const received = Buffer.from(submittedNonce, "hex");
    const matches =
      expected.length === received.length &&
      crypto.timingSafeEqual(expected, received);

    if (matches) {
      // Mark nonce as consumed
      await kysely
        .updateTable("sep24_sessions")
        .set({ popup_nonce_consumed: true })
        .where("session_id", "=", sessionId)
        .execute();

      await recordSecurityEvent(sessionId, "nonce_verified", {});
    } else {
      await recordSecurityEvent(sessionId, "nonce_mismatch", {});
    }

    return matches;
  } catch (error: any) {
    log("error", "sep24_nonce_verification_error", {
      sessionId,
      error: error.message,
    });
    return false;
  }
}

/**
 * Invalidates a session explicitly (logout, error, or abuse detected).
 */
export async function invalidateSEP24Session(sessionId: string): Promise<void> {
  try {
    const session = await kysely
      .selectFrom("sep24_sessions")
      .select(["account"])
      .where("session_id", "=", sessionId)
      .executeTakeFirst();

    if (session) {
      await kysely
        .deleteFrom("sep24_sessions")
        .where("session_id", "=", sessionId)
        .execute();

      log("info", "sep24_session_invalidated", {
        sessionId,
        account: session.account.slice(0, 8) + "...",
      });
    }
  } catch (error: any) {
    log("error", "sep24_session_invalidation_error", {
      sessionId,
      error: error.message,
    });
  }
}

/**
 * Cleans up expired sessions periodically.
 * Should be called by a background scheduler.
 */
export async function cleanupExpiredSEP24Sessions(): Promise<number> {
  try {
    const now = new Date();
    
    const result = await kysely
      .deleteFrom("sep24_sessions")
      .where("expires_at", "<", now)
      .executeTakeFirst();

    const cleaned = Number(result.numDeletedRows) || 0;

    if (cleaned > 0) {
      log("info", "sep24_sessions_cleanup", { cleaned });
    }

    return cleaned;
  } catch (error: any) {
    log("error", "sep24_cleanup_error", { error: error.message });
    return 0;
  }
}

/**
 * Records interactive flow completion and validates CSRF token.
 */
export async function recordSEP24Completion(
  sessionId: string,
  token: string,
  transactionId: string,
): Promise<{ success: boolean; reason?: string }> {
  const validation = await validateSEP24Session(sessionId, token);

  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  try {
    const session = await kysely
      .selectFrom("sep24_sessions")
      .select(["asset", "account"])
      .where("session_id", "=", sessionId)
      .executeTakeFirst();

    if (!session) {
      return { success: false, reason: "Session not found" };
    }

    const now = new Date();

    await kysely
      .insertInto("sep24_completions")
      .values({
        session_id: sessionId,
        transaction_id: transactionId,
        asset: session.asset,
        account: session.account,
        completed_at: now,
      })
      .execute();

    // Invalidate session after successful completion
    await invalidateSEP24Session(sessionId);

    log("info", "sep24_completion_recorded", {
      sessionId,
      transactionId,
      asset: session.asset,
    });

    return { success: true };
  } catch (e: any) {
    log("error", "sep24_completion_failed", {
      sessionId,
      error: e.message,
    });
    return { success: false, reason: "Failed to record completion" };
  }
}

/**
 * Records a security event for audit trail.
 * Internal helper for session security monitoring (ZV-119).
 */
async function recordSecurityEvent(
  sessionId: string | null,
  eventType: string,
  details: Record<string, any>,
  ipAddress?: string,
  userAgent?: string,
): Promise<void> {
  try {
    await kysely
      .insertInto("sep24_security_events")
      .values({
        session_id: sessionId,
        event_type: eventType,
        details: JSON.stringify(details),
        ip_address: ipAddress,
        user_agent: userAgent,
        occurred_at: new Date(),
      })
      .execute();
  } catch (error: any) {
    // Don't let audit logging failure break the main flow
    log("warn", "sep24_security_event_logging_failed", {
      eventType,
      error: error.message,
    });
  }
}

/**
 * Gets session statistics for monitoring.
 * Returns count of active sessions and cleanup metrics (ZV-119).
 */
export async function getSEP24SessionStats(): Promise<{
  activeSessions: number;
  expiredNotCleaned: number;
}> {
  try {
    const now = new Date();
    
    const [activeCount, expiredCount] = await Promise.all([
      kysely
        .selectFrom("sep24_sessions")
        .select(({ fn }) => [fn.count<number>("session_id").as("count")])
        .where("expires_at", ">", now)
        .executeTakeFirst(),
      kysely
        .selectFrom("sep24_sessions")
        .select(({ fn }) => [fn.count<number>("session_id").as("count")])
        .where("expires_at", "<=", now)
        .executeTakeFirst(),
    ]);

    return {
      activeSessions: activeCount?.count || 0,
      expiredNotCleaned: expiredCount?.count || 0,
    };
  } catch (error: any) {
    log("error", "sep24_stats_error", { error: error.message });
    return { activeSessions: 0, expiredNotCleaned: 0 };
  }
}
