/**
 * Relayer Approval Manager (#962)
 * 
 * Manages co-signer approval secrets with rotation, revocation, and audit trail.
 * Implements the secret lifecycle described in ZV-123.
 */

import crypto from "crypto";
import { getDb } from "./db.js";
import { log } from "./logger.js";
import { getSecret, setSecret } from "./secrets/secret-manager.js";

export interface ApprovalRecord {
  id: string;
  approval_id: string;
  cosigner_id: string;
  tx_hash: string;
  tier: "hot" | "warm" | "cold";
  issued_at: string;
  expires_at: string;
  used_at?: string;
  revoked_at?: string;
  revocation_reason?: string;
  secret_version: number;
}

export interface ApprovalSecret {
  version: number;
  cosigner_id: string;
  secret_key: string;
  activated_at: string;
  deprecated_at?: string;
  revoked_at?: string;
  revocation_reason?: string;
  overlap_window_ms: number;
}

/**
 * Initialize a cosigner's approval secret
 */
export async function initializeApprovalSecret(
  cosignerId: string,
  overlapWindowMs = 300000, // 5 minutes
): Promise<ApprovalSecret> {
  const db = getDb();
  
  // Generate new secret
  const secretKey = crypto.randomBytes(32).toString("hex");
  
  // Get next version
  const lastVersion = db
    .prepare("SELECT MAX(version) as max_version FROM relayer_approval_secrets WHERE cosigner_id = ?")
    .get(cosignerId) as any;
  
  const version = (lastVersion?.max_version || 0) + 1;
  
  // Store in managed secret backend
  await setSecret(`APPROVAL_SECRET_${cosignerId}_V${version}`, secretKey, {
    metadata: {
      key: `APPROVAL_SECRET_${cosignerId}_V${version}`,
      rotationIntervalMs: 90 * 24 * 60 * 60 * 1000, // 90 days
    },
  });
  
  // Record in database
  db.prepare(`
    INSERT INTO relayer_approval_secrets 
    (version, cosigner_id, secret_key, activated_at, overlap_window_ms)
    VALUES (?, ?, ?, datetime('now'), ?)
  `).run(version, cosignerId, `encrypted:${cosignerId}:v${version}`, overlapWindowMs);
  
  // Audit event
  db.prepare(`
    INSERT INTO relayer_approval_audit 
    (event_type, cosigner_id, timestamp, actor, reason)
    VALUES (?, ?, datetime('now'), ?, ?)
  `).run("secret_rotated", cosignerId, "system", "initial_setup");
  
  log("info", "approval_secret_initialized", {
    cosignerId,
    version,
    overlapWindowMs,
  });
  
  return {
    version,
    cosigner_id: cosignerId,
    secret_key: secretKey,
    activated_at: new Date().toISOString(),
    overlap_window_ms: overlapWindowMs,
  };
}

/**
 * Rotate an approval secret with overlap window for in-flight transactions
 */
export async function rotateApprovalSecret(
  cosignerId: string,
  overlapWindowMs = 300000,
): Promise<{ oldVersion: number; newVersion: number }> {
  const db = getDb();
  
  // Get current version
  const current = db
    .prepare(`
      SELECT * FROM relayer_approval_secrets 
      WHERE cosigner_id = ? AND deprecated_at IS NULL AND revoked_at IS NULL
      ORDER BY version DESC LIMIT 1
    `)
    .get(cosignerId) as ApprovalSecret | undefined;
  
  if (!current) {
    throw new Error(`No active secret found for cosigner ${cosignerId}`);
  }
  
  // Mark current as deprecated (but still valid during overlap)
  db.prepare(`
    UPDATE relayer_approval_secrets
    SET deprecated_at = datetime('now')
    WHERE version = ? AND cosigner_id = ?
  `).run(current.version, cosignerId);
  
  // Create new secret
  const newSecret = await initializeApprovalSecret(cosignerId, overlapWindowMs);
  
  log("info", "approval_secret_rotated", {
    cosignerId,
    oldVersion: current.version,
    newVersion: newSecret.version,
    overlapWindowMs,
  });
  
  return {
    oldVersion: current.version,
    newVersion: newSecret.version,
  };
}

/**
 * Revoke a compromised secret immediately
 */
export function revokeApprovalSecret(
  cosignerId: string,
  version: number,
  reason: string,
  actor: string,
): void {
  const db = getDb();
  
  // Revoke the secret
  db.prepare(`
    UPDATE relayer_approval_secrets
    SET revoked_at = datetime('now'), revocation_reason = ?
    WHERE version = ? AND cosigner_id = ?
  `).run(reason, version, cosignerId);
  
  // Revoke all pending approvals signed with this secret
  const revokedCount = db
    .prepare(`
      UPDATE relayer_approval_records
      SET revoked_at = datetime('now'), revocation_reason = ?
      WHERE secret_version = ? AND cosigner_id = ?
        AND revoked_at IS NULL AND used_at IS NULL
    `)
    .run(`secret_compromised:${reason}`, version, cosignerId).changes;
  
  // Audit event
  db.prepare(`
    INSERT INTO relayer_approval_audit 
    (event_type, cosigner_id, timestamp, actor, reason, metadata)
    VALUES (?, ?, datetime('now'), ?, ?, ?)
  `).run(
    "secret_compromised",
    cosignerId,
    actor,
    reason,
    JSON.stringify({ version, revokedApprovals: revokedCount }),
  );
  
  log("warn", "approval_secret_revoked", {
    cosignerId,
    version,
    reason,
    actor,
    revokedApprovals: revokedCount,
  });
}

/**
 * Record an issued approval
 */
export function recordApproval(
  approvalId: string,
  cosignerId: string,
  txHash: string,
  tier: "hot" | "warm" | "cold",
  expiresAtMs: number,
  secretVersion: number,
  issuerIdentity?: string,
  requestId?: string,
): void {
  const db = getDb();
  
  db.prepare(`
    INSERT INTO relayer_approval_records 
    (approval_id, cosigner_id, tx_hash, tier, expires_at, secret_version, issuer_identity, request_id)
    VALUES (?, ?, ?, ?, datetime(? / 1000, 'unixepoch'), ?, ?, ?)
  `).run(
    approvalId,
    cosignerId,
    txHash,
    tier,
    expiresAtMs,
    secretVersion,
    issuerIdentity || null,
    requestId || null,
  );
  
  // Audit event
  db.prepare(`
    INSERT INTO relayer_approval_audit 
    (event_type, approval_id, cosigner_id, tx_hash, tier, timestamp, metadata)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    "approval_issued",
    approvalId,
    cosignerId,
    txHash,
    tier,
    JSON.stringify({ secretVersion, requestId }),
  );
}

/**
 * Mark an approval as used
 */
export function markApprovalUsed(approvalId: string, actor?: string): void {
  const db = getDb();
  
  db.prepare(`
    UPDATE relayer_approval_records
    SET used_at = datetime('now')
    WHERE approval_id = ?
  `).run(approvalId);
  
  const record = db
    .prepare("SELECT * FROM relayer_approval_records WHERE approval_id = ?")
    .get(approvalId) as ApprovalRecord | undefined;
  
  if (record) {
    db.prepare(`
      INSERT INTO relayer_approval_audit 
      (event_type, approval_id, cosigner_id, tx_hash, tier, timestamp, actor)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(
      "approval_used",
      approvalId,
      record.cosigner_id,
      record.tx_hash,
      record.tier,
      actor || null,
    );
  }
}

/**
 * Get active secret for a cosigner
 */
export async function getActiveApprovalSecret(
  cosignerId: string,
): Promise<string | null> {
  const db = getDb();
  
  // Get current active secret
  const secret = db
    .prepare(`
      SELECT * FROM relayer_approval_secrets 
      WHERE cosigner_id = ? 
        AND revoked_at IS NULL 
        AND (deprecated_at IS NULL OR 
             datetime(deprecated_at, '+' || overlap_window_ms || ' milliseconds') > datetime('now'))
      ORDER BY version DESC LIMIT 1
    `)
    .get(cosignerId) as ApprovalSecret | undefined;
  
  if (!secret) {
    return null;
  }
  
  // Retrieve from managed secret backend
  const secretKey = await getSecret(`APPROVAL_SECRET_${cosignerId}_V${secret.version}`);
  return secretKey || null;
}

/**
 * Verify an approval token with secret version validation
 */
export async function verifyApprovalToken(
  approvalToken: string,
  txHash: string,
  tier: "hot" | "warm" | "cold",
): Promise<{ valid: boolean; cosignerId?: string; secretVersion?: number }> {
  const db = getDb();
  
  // Parse token: cosignerId.expiresAtMs.mac
  const parts = approvalToken.split(".");
  if (parts.length !== 3) {
    return { valid: false };
  }
  
  const [cosignerId, expiresAtStr, providedMac] = parts;
  const expiresAtMs = parseInt(expiresAtStr, 10);
  
  // Check expiration
  if (Date.now() > expiresAtMs) {
    log("warn", "approval_expired", { cosignerId, txHash, tier });
    return { valid: false };
  }
  
  // Get all potentially valid secrets (active + overlap window)
  const secrets = db
    .prepare(`
      SELECT * FROM relayer_approval_secrets 
      WHERE cosigner_id = ? 
        AND revoked_at IS NULL
        AND datetime(activated_at) <= datetime('now')
        AND (deprecated_at IS NULL OR 
             datetime(deprecated_at, '+' || overlap_window_ms || ' milliseconds') > datetime('now'))
      ORDER BY version DESC
    `)
    .all(cosignerId) as ApprovalSecret[];
  
  // Try each secret version
  for (const secret of secrets) {
    const secretKey = await getSecret(`APPROVAL_SECRET_${cosignerId}_V${secret.version}`);
    if (!secretKey) continue;
    
    const expectedMac = crypto
      .createHmac("sha256", secretKey)
      .update(`zkvote-relayer-approval:v1:${txHash}:${tier}:${expiresAtMs}`)
      .digest("hex");
    
    // Timing-safe comparison
    try {
      const providedBuf = Buffer.from(providedMac, "hex");
      const expectedBuf = Buffer.from(expectedMac, "hex");
      
      if (
        providedBuf.length === expectedBuf.length &&
        providedBuf.length > 0 &&
        crypto.timingSafeEqual(providedBuf, expectedBuf)
      ) {
        return { valid: true, cosignerId, secretVersion: secret.version };
      }
    } catch {
      continue;
    }
  }
  
  log("warn", "approval_verification_failed", { cosignerId, txHash, tier });
  return { valid: false };
}

/**
 * Clean up old approval records (older than retention period)
 */
export function cleanupOldApprovals(retentionDays = 90): number {
  const db = getDb();
  
  const result = db
    .prepare(`
      DELETE FROM relayer_approval_records
      WHERE (
        revoked_at IS NOT NULL OR 
        used_at IS NOT NULL OR 
        datetime(expires_at) < datetime('now')
      )
      AND datetime(COALESCE(used_at, revoked_at, expires_at)) < datetime('now', '-' || ? || ' days')
    `)
    .run(retentionDays);
  
  if (result.changes > 0) {
    log("info", "approval_records_cleaned", {
      removed: result.changes,
      retentionDays,
    });
  }
  
  return result.changes;
}
