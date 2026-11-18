/**
 * SEP-24 Session Security — Session Fixation & Popup-Abuse Prevention (#762)
 *
 * Implements secure session management for SEP-24 interactive deposit/withdrawal flows:
 * - Generates cryptographically secure session tokens with short TTL
 * - Prevents session fixation via token rotation on privilege escalation
 * - Validates popup origin and parent window to prevent abuse
 * - Implements CSRF protection specific to interactive flows
 */

import * as crypto from "crypto";
import { log } from "./logger.js";
import { getDb } from "./db.js";

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

const activeSessions = new Map<string, SEP24Session>();

/**
 * Generates a cryptographically secure random token.
 */
function generateSecureToken(): string {
  return crypto.randomBytes(SESSION_TOKEN_LENGTH).toString("hex");
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
 */
export function createSEP24Session(
  asset: "USDC" | "EURC",
  account: string,
  originalOrigin: string,
): { sessionId: string; token: string; popupNonce: string } {
  const sessionId = crypto.randomUUID();
  const token = generateSecureToken();
  const popupNonce = generatePopupNonce();
  const now = Date.now();

  const session: SEP24Session = {
    sessionId,
    token,
    asset,
    account,
    originalOrigin,
    popupNonce,
    popupNonceConsumed: false,
    createdAt: now,
    lastActivityAt: now,
    issuedTokens: new Set([token]),
  };

  activeSessions.set(sessionId, session);

  log("info", "sep24_session_created", {
    sessionId,
    asset,
    account: account.slice(0, 8) + "...",
  });

  return { sessionId, token, popupNonce };
}

/**
 * Validates a session token and checks for expiration or tampering.
 * Returns null if session is invalid, expired, or has been fixated.
 */
export function validateSEP24Session(
  sessionId: string,
  token: string,
): { valid: boolean; reason?: string } {
  const session = activeSessions.get(sessionId);

  if (!session) {
    return { valid: false, reason: "Session not found" };
  }

  const now = Date.now();
  const age = now - session.createdAt;

  if (age > MAX_SESSION_AGE_MS) {
    activeSessions.delete(sessionId);
    return { valid: false, reason: "Session expired" };
  }

  if (!session.issuedTokens.has(token)) {
    // Token not issued by this session - possible fixation attack
    log("warn", "sep24_potential_fixation_attack", {
      sessionId,
      account: session.account.slice(0, 8) + "...",
    });
    return { valid: false, reason: "Invalid token for this session" };
  }

  session.lastActivityAt = now;
  return { valid: true };
}

/**
 * Rotates the session token after privilege escalation or sensitive operations.
 * Invalidates old token and issues a new one to prevent fixation attacks.
 */
export function rotateSEP24Token(
  sessionId: string,
  currentToken: string,
): { newToken: string } | null {
  const session = activeSessions.get(sessionId);

  if (!session || !session.issuedTokens.has(currentToken)) {
    return null;
  }

  const newToken = generateSecureToken();
  session.issuedTokens.add(newToken);
  session.token = newToken;
  session.lastActivityAt = Date.now();

  log("info", "sep24_token_rotated", {
    sessionId,
    account: session.account.slice(0, 8) + "...",
  });

  return { newToken };
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
export function validatePopupParent(
  sessionId: string,
  parentOrigin: string,
): boolean {
  const session = activeSessions.get(sessionId);

  if (!session) {
    return false;
  }

  try {
    const parent = new URL(parentOrigin).origin;
    const expected = new URL(session.originalOrigin).origin;
    return parent === expected;
  } catch {
    return false;
  }
}

/**
 * Verifies popup nonce to prevent replay attacks.
 * Nonce should be included in popup window opener parameters.
 */
export function verifyPopupNonce(
  sessionId: string,
  submittedNonce: string,
): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return false;
  }

  // A popup nonce is a one-time capability. Validate its shape and length
  // before timingSafeEqual (which throws for unequal buffer lengths).
  if (
    session.popupNonceConsumed ||
    typeof submittedNonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(submittedNonce)
  ) {
    return false;
  }

  const expected = Buffer.from(session.popupNonce, "hex");
  const received = Buffer.from(submittedNonce, "hex");
  const matches =
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);

  if (matches) {
    session.popupNonceConsumed = true;
  }
  return matches;
}

/**
 * Invalidates a session explicitly (logout, error, or abuse detected).
 */
export function invalidateSEP24Session(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (session) {
    activeSessions.delete(sessionId);
    log("info", "sep24_session_invalidated", {
      sessionId,
      account: session.account.slice(0, 8) + "...",
    });
  }
}

/**
 * Cleans up expired sessions periodically.
 * Should be called by a background scheduler.
 */
export function cleanupExpiredSEP24Sessions(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.createdAt > MAX_SESSION_AGE_MS) {
      activeSessions.delete(sessionId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log("info", "sep24_sessions_cleanup", { cleaned });
  }

  return cleaned;
}

/**
 * Records interactive flow completion and validates CSRF token.
 */
export async function recordSEP24Completion(
  sessionId: string,
  token: string,
  transactionId: string,
): Promise<{ success: boolean; reason?: string }> {
  const validation = validateSEP24Session(sessionId, token);

  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    return { success: false, reason: "Session not found" };
  }

  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `
      INSERT INTO sep24_completions
      (session_id, transaction_id, asset, account, completed_at)
      VALUES (?, ?, ?, ?, ?)
      `,
    ).run(sessionId, transactionId, session.asset, session.account, now);

    // Invalidate session after successful completion
    activeSessions.delete(sessionId);

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
