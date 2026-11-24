/**
 * Abuse Detection Service - Payment Washing & Structuring Pattern Detection
 * 
 * Detects financial abuse patterns while maintaining privacy:
 * - Wash payments (self-dealing volume)
 * - Structuring (splitting to evade thresholds)
 * - Mule patterns (many accounts converging)
 * - Metadata-only analysis (never vote linkage)
 */

import crypto from "crypto";
import {
  notificationFromDisputeResolution,
  publishNotificationEventSafely,
} from "./notifications/index.js";
import { log } from "./logger.js";
import { getDb } from "./db.js";
import { dispatchAbuseDetectionToSiem } from "./abuse-siem.js";

/**
 * Abuse pattern types
 */
export enum AbusePattern {
  WASH_PAYMENT = "wash_payment",
  STRUCTURING = "structuring",
  MULE_CONVERGENCE = "mule_convergence",
  RAPID_CYCLING = "rapid_cycling",
  THRESHOLD_EVASION = "threshold_evasion",
}

/**
 * Abuse detection thresholds (configurable per deployment)
 */
export const ABUSE_THRESHOLDS = {
  // Structuring: multiple payments just below threshold within time window
  STRUCTURING_AMOUNT: BigInt(10000 * 1e7), // 10,000 XLM equivalent
  STRUCTURING_WINDOW_MS: 24 * 60 * 60 * 1000, // 24 hours
  STRUCTURING_MIN_COUNT: 5, // 5+ payments just below threshold

  // Wash payments: same sender/receiver pair within short window
  WASH_WINDOW_MS: 60 * 60 * 1000, // 1 hour
  WASH_MIN_ROUNDTRIPS: 3, // 3+ roundtrips

  // Mule convergence: many senders to single receiver
  MULE_WINDOW_MS: 24 * 60 * 60 * 1000, // 24 hours
  MULE_MIN_SENDERS: 10, // 10+ unique senders
  MULE_MIN_AMOUNT: BigInt(1000 * 1e7), // 1,000 XLM total

  // Rapid cycling: deposit -> pay -> withdraw within minutes
  RAPID_CYCLE_WINDOW_MS: 15 * 60 * 1000, // 15 minutes

  // Threshold evasion: amounts clustering just below reporting thresholds
  THRESHOLD_MARGIN: 0.95, // Within 95% of threshold

  // Enforcement tiers (ZV-111): confidence bands that select the graduated
  // action taken on a detection. Bumping this file's values must also bump
  // ABUSE_THRESHOLDS_VERSION so tuning changes are auditable and the
  // labelled-fixture regression test (abuseEnforcement.test.ts) is forced
  // to re-confirm expected behavior against the drill scenarios in
  // docs/abuse-detection-policy.md.
  HOLD_CONFIDENCE: 0.5, // >= this: hold payment pending dual-control review
  BLOCK_CONFIDENCE: 0.9, // >= this: hard block, mandatory review
} as const;

/**
 * Version stamp for the threshold/action tuning above. Anything that reads
 * or stores a confidence-derived action should also persist this value so
 * historical holds/cases remain interpretable after thresholds change.
 */
export const ABUSE_THRESHOLDS_VERSION = "2026.11.0";

/**
 * Graduated enforcement actions (ZV-111). Detection alone ("suspicious")
 * only ever advised; this maps a confidence score to what the system
 * actually does about it.
 */
export enum AbuseAction {
  NONE = "none",
  FLAG = "flag",
  HOLD = "hold",
  BLOCK = "block",
}

/**
 * Human/audit-facing reason codes, one per pattern, attached to every hold
 * and dispute case so a reviewer never has to re-derive "why" from raw
 * detector metadata.
 */
export const ABUSE_REASON_CODES: Record<AbusePattern, string> = {
  [AbusePattern.WASH_PAYMENT]: "WASH_PAYMENT_ROUNDTRIP",
  [AbusePattern.STRUCTURING]: "STRUCTURING_THRESHOLD_EVASION",
  [AbusePattern.MULE_CONVERGENCE]: "MULE_CONVERGENCE_FANIN",
  [AbusePattern.RAPID_CYCLING]: "RAPID_CYCLING_MIXER_LIKE",
  [AbusePattern.THRESHOLD_EVASION]: "THRESHOLD_EVASION",
};

/** Fields that must never appear in an abuse evidence bundle (ZV-010 privacy red lines). */
const FORBIDDEN_EVIDENCE_KEYS = [
  "nullifier",
  "voteNullifier",
  "vote_nullifier",
  "membershipProof",
  "membership_proof",
  "ballotCommitment",
  "ballot_commitment",
  "daoId",
  "dao_id",
  "proposalId",
  "proposal_id",
];

/**
 * Recursively check that an evidence object carries no vote/membership
 * linkage. Thrown errors here are a hard stop: abuse evidence is payment
 * metadata only and must never become a deanonymization oracle.
 */
export function assertNoVoteLinkage(value: unknown, path = "evidence"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoVoteLinkage(item, `${path}[${i}]`));
    return;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_EVIDENCE_KEYS.includes(key)) {
      throw new Error(
        `Privacy violation: evidence bundle contains forbidden key "${path}.${key}" (vote/membership linkage is never permitted in abuse evidence)`
      );
    }
    assertNoVoteLinkage(val, `${path}.${key}`);
  }
}

/**
 * Select the graduated enforcement action for a confidence score.
 */
export function determineAction(suspicious: boolean, confidence: number): AbuseAction {
  if (!suspicious) return AbuseAction.NONE;
  if (confidence >= ABUSE_THRESHOLDS.BLOCK_CONFIDENCE) return AbuseAction.BLOCK;
  if (confidence >= ABUSE_THRESHOLDS.HOLD_CONFIDENCE) return AbuseAction.HOLD;
  return AbuseAction.FLAG;
}

/**
 * Abuse detection result
 */
export interface AbuseDetectionResult {
  suspicious: boolean;
  patterns: AbusePattern[];
  confidence: number; // 0.0 to 1.0
  metadata: Record<string, any>;
  timestamp: number;
}

/**
 * Payment metadata for pattern analysis (privacy-bounded)
 */
export interface PaymentMetadata {
  hash: string;
  tenantId: string;
  amount: bigint;
  destinations: string[];
  timestamp: number;
}

/**
 * Detect structuring pattern: multiple payments just below threshold
 */
export function detectStructuring(
  payments: PaymentMetadata[],
  windowMs: number = ABUSE_THRESHOLDS.STRUCTURING_WINDOW_MS
): AbuseDetectionResult {
  const now = Date.now();
  const recentPayments = payments.filter(
    p => now - p.timestamp < windowMs
  );

  // Count payments just below threshold
  const nearThreshold = recentPayments.filter(p => {
    const ratio = Number(p.amount) / Number(ABUSE_THRESHOLDS.STRUCTURING_AMOUNT);
    return ratio >= ABUSE_THRESHOLDS.THRESHOLD_MARGIN && ratio < 1.0;
  });

  const suspicious = nearThreshold.length >= ABUSE_THRESHOLDS.STRUCTURING_MIN_COUNT;
  
  if (suspicious) {
    log("warn", "structuring_pattern_detected", {
      paymentCount: nearThreshold.length,
      windowMs,
      totalAmount: nearThreshold.reduce((sum, p) => sum + p.amount, BigInt(0)).toString(),
    });
  }

  return {
    suspicious,
    patterns: suspicious ? [AbusePattern.STRUCTURING] : [],
    confidence: Math.min(nearThreshold.length / ABUSE_THRESHOLDS.STRUCTURING_MIN_COUNT, 1.0),
    metadata: {
      nearThresholdCount: nearThreshold.length,
      windowMs,
    },
    timestamp: now,
  };
}

/**
 * Detect wash payment pattern: same pair roundtripping funds
 */
export function detectWashPayments(
  payments: PaymentMetadata[],
  windowMs: number = ABUSE_THRESHOLDS.WASH_WINDOW_MS
): AbuseDetectionResult {
  const now = Date.now();
  const recentPayments = payments.filter(
    p => now - p.timestamp < windowMs
  );

  // Build destination pair frequency map
  const pairCounts = new Map<string, number>();
  
  for (const payment of recentPayments) {
    for (const dest of payment.destinations) {
      // Sort pair to detect bidirectional flows
      const pair = [payment.tenantId, dest].sort().join(":");
      pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
    }
  }

  // Find pairs with high roundtrip counts
  const suspiciousPairs = Array.from(pairCounts.entries())
    .filter(([_, count]) => count >= ABUSE_THRESHOLDS.WASH_MIN_ROUNDTRIPS);

  const suspicious = suspiciousPairs.length > 0;
  
  if (suspicious) {
    log("warn", "wash_payment_pattern_detected", {
      pairCount: suspiciousPairs.length,
      maxRoundtrips: Math.max(...suspiciousPairs.map(([_, count]) => count)),
      windowMs,
    });
  }

  return {
    suspicious,
    patterns: suspicious ? [AbusePattern.WASH_PAYMENT] : [],
    confidence: suspicious ? Math.min(suspiciousPairs[0][1] / ABUSE_THRESHOLDS.WASH_MIN_ROUNDTRIPS, 1.0) : 0,
    metadata: {
      suspiciousPairCount: suspiciousPairs.length,
      windowMs,
    },
    timestamp: now,
  };
}

/**
 * Detect mule convergence: many senders to single receiver
 */
export function detectMuleConvergence(
  destination: string,
  windowMs: number = ABUSE_THRESHOLDS.MULE_WINDOW_MS
): AbuseDetectionResult {
  const db = getDb();
  const windowStart = Date.now() - windowMs;

  // Query payments to this destination within window
  const query = `
    SELECT 
      COUNT(DISTINCT tenant_id) as unique_senders,
      SUM(amount) as total_amount,
      COUNT(*) as payment_count
    FROM payment_jobs
    WHERE created_at >= datetime(?, 'unixepoch', 'subsec')
      AND ops LIKE ?
  `;

  const row = db.prepare(query).get(
    windowStart / 1000,
    `%"destination":"${destination}"%`
  ) as { unique_senders: number; total_amount: string; payment_count: number } | undefined;

  if (!row) {
    return {
      suspicious: false,
      patterns: [],
      confidence: 0,
      metadata: {},
      timestamp: Date.now(),
    };
  }

  const uniqueSenders = row.unique_senders || 0;
  const totalAmount = BigInt(row.total_amount || "0");
  
  const suspicious = 
    uniqueSenders >= ABUSE_THRESHOLDS.MULE_MIN_SENDERS &&
    totalAmount >= ABUSE_THRESHOLDS.MULE_MIN_AMOUNT;

  if (suspicious) {
    log("warn", "mule_convergence_pattern_detected", {
      destination: destination.slice(0, 8) + "...",
      uniqueSenders,
      totalAmount: totalAmount.toString(),
      paymentCount: row.payment_count,
      windowMs,
    });
  }

  return {
    suspicious,
    patterns: suspicious ? [AbusePattern.MULE_CONVERGENCE] : [],
    confidence: Math.min(uniqueSenders / ABUSE_THRESHOLDS.MULE_MIN_SENDERS, 1.0),
    metadata: {
      uniqueSenders,
      totalAmount: totalAmount.toString(),
      paymentCount: row.payment_count,
      windowMs,
    },
    timestamp: Date.now(),
  };
}

/**
 * Analyze batch payment for multiple abuse patterns
 */
export function analyzeBatchPayment(
  tenantId: string,
  ops: Array<{ destination: string; amount: string; asset: string }>,
  timestamp: number = Date.now()
): AbuseDetectionResult {
  const db = getDb();
  
  // Get recent payment history for this tenant
  const recentWindow = 24 * 60 * 60 * 1000; // 24 hours
  const windowStart = timestamp - recentWindow;
  
  const recentPayments = db
    .prepare(
      `SELECT id, tenant_id, amount, ops, created_at 
       FROM payment_jobs 
       WHERE tenant_id = ? AND created_at >= datetime(?, 'unixepoch', 'subsec')
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .all(tenantId, windowStart / 1000) as Array<{
      id: string;
      tenant_id: string;
      amount: string;
      ops: string;
      created_at: string;
    }>;

  // Convert to PaymentMetadata
  const metadata: PaymentMetadata[] = recentPayments.map(p => ({
    hash: p.id,
    tenantId: p.tenant_id,
    amount: BigInt(p.amount),
    destinations: JSON.parse(p.ops).map((op: any) => op.destination),
    timestamp: new Date(p.created_at).getTime(),
  }));

  // Add current batch to analysis
  const currentAmount = ops.reduce(
    (sum, op) => sum + BigInt(Math.floor(parseFloat(op.amount) * 1e7)),
    BigInt(0)
  );
  metadata.push({
    hash: "pending",
    tenantId,
    amount: currentAmount,
    destinations: ops.map(op => op.destination),
    timestamp,
  });

  // Run all detection algorithms
  const structuringResult = detectStructuring(metadata);
  const washResult = detectWashPayments(metadata);

  // Check each destination for mule convergence
  const destinations = new Set(ops.map(op => op.destination));
  const muleResults = Array.from(destinations).map(dest =>
    detectMuleConvergence(dest)
  );
  const muleDetected = muleResults.some(r => r.suspicious);

  // Combine results
  const allPatterns = [
    ...structuringResult.patterns,
    ...washResult.patterns,
    ...muleResults.flatMap(r => r.patterns),
  ];

  const suspicious = allPatterns.length > 0;
  const confidence = Math.max(
    structuringResult.confidence,
    washResult.confidence,
    ...muleResults.map(r => r.confidence)
  );

  if (suspicious) {
    log("warn", "batch_abuse_detected", {
      tenantId,
      patterns: allPatterns,
      confidence,
      opsCount: ops.length,
      amount: currentAmount.toString(),
    });
  }

  return {
    suspicious,
    patterns: allPatterns,
    confidence,
    metadata: {
      structuring: structuringResult.metadata,
      wash: washResult.metadata,
      mule: muleResults.filter(r => r.suspicious).map(r => r.metadata),
    },
    timestamp,
  };
}

/**
 * Record abuse detection result to audit log
 */
export function recordAbuseDetection(
  result: AbuseDetectionResult,
  tenantId: string,
  context: Record<string, any>
): void {
  if (!result.suspicious) return;

  const db = getDb();
  
  // Store in audit_log for compliance
  db.prepare(
    `INSERT INTO audit_log (
      tenant_id, event_type, actor_type, actor_id, target_type, target_id, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tenantId,
    "abuse_detection",
    "system",
    "abuse-detector",
    "payment",
    context.paymentHash || "batch",
    JSON.stringify({
      patterns: result.patterns,
      confidence: result.confidence,
      metadata: result.metadata,
      context,
    }),
    new Date(result.timestamp).toISOString()
  );

  log("info", "abuse_detection_recorded", {
    tenantId,
    patterns: result.patterns,
    confidence: result.confidence,
  });

  // Keep the synchronous audit write authoritative while delivering SIEM
  // notifications asynchronously. A remote outage must not break payment
  // processing or erase the local compliance record.
  void dispatchAbuseDetectionToSiem(result).catch((error: unknown) => {
    log("error", "abuse_detection_siem_delivery_failed", {
      error: error instanceof Error ? error.message : "Unknown SIEM delivery error",
      patterns: result.patterns,
    });
  });
}

/**
 * Get abuse detection statistics for monitoring
 */
export function getAbuseStats(
  windowMs: number = 24 * 60 * 60 * 1000
): Record<string, number> {
  const db = getDb();
  const windowStart = Date.now() - windowMs;

  const rows = db
    .prepare(
      `SELECT metadata FROM audit_log 
       WHERE event_type = 'abuse_detection' 
         AND created_at >= datetime(?, 'unixepoch', 'subsec')`
    )
    .all(windowStart / 1000) as Array<{ metadata: string }>;

  const stats: Record<string, number> = {
    total_detections: rows.length,
  };

  for (const row of rows) {
    const meta = JSON.parse(row.metadata);
    for (const pattern of meta.patterns || []) {
      stats[pattern] = (stats[pattern] || 0) + 1;
    }
  }

  return stats;
}

// ============================================
// ENFORCEMENT & DISPUTE-CASE LINKAGE (ZV-111)
// ============================================

export type HoldStatus = "held" | "pending_release" | "released" | "escalated";

export interface PaymentHold {
  id: string;
  tenantId: string;
  paymentRef: string;
  action: AbuseAction;
  reasonCode: string;
  patterns: AbusePattern[];
  confidence: number;
  thresholdsVersion: string;
  status: HoldStatus;
  evidence: Record<string, unknown>;
  disputeCaseId: string | null;
  firstReviewerId: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  createdAt: string;
}

interface PaymentHoldRow {
  id: string;
  tenant_id: string;
  payment_ref: string;
  action: string;
  reason_code: string;
  patterns: string;
  confidence: number;
  thresholds_version: string;
  status: HoldStatus;
  evidence: string;
  dispute_case_id: string | null;
  first_reviewer_id: string | null;
  first_review_at: string | null;
  first_review_reason: string | null;
  released_by: string | null;
  released_at: string | null;
  release_reason: string | null;
  created_at: string;
}

function rowToHold(row: PaymentHoldRow): PaymentHold {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    paymentRef: row.payment_ref,
    action: row.action as AbuseAction,
    reasonCode: row.reason_code,
    patterns: JSON.parse(row.patterns),
    confidence: row.confidence,
    thresholdsVersion: row.thresholds_version,
    status: row.status,
    evidence: JSON.parse(row.evidence),
    disputeCaseId: row.dispute_case_id,
    firstReviewerId: row.first_reviewer_id,
    releasedBy: row.released_by,
    releasedAt: row.released_at,
    createdAt: row.created_at,
  };
}

/**
 * Place a flagged payment on hold (or hard-block it) and open a linked
 * dispute case with an evidence bundle. The evidence bundle is asserted
 * privacy-clean before it is ever written - this is the enforcement hook
 * the policy doc describes as missing (detection was advisory only).
 *
 * Returns null for AbuseAction.NONE/FLAG, since those tiers do not create
 * a case - they are logged via recordAbuseDetection() only.
 */
export function placeOnHold(input: {
  tenantId: string;
  paymentRef: string;
  action: AbuseAction;
  patterns: AbusePattern[];
  confidence: number;
  evidence: Record<string, unknown>;
}): { holdId: string; disputeCaseId: string | null } | null {
  if (input.action === AbuseAction.NONE || input.action === AbuseAction.FLAG) {
    return null;
  }

  assertNoVoteLinkage(input.evidence);

  const db = getDb();
  const holdId = crypto.randomUUID();
  const reasonCode =
    input.patterns.map((p) => ABUSE_REASON_CODES[p]).join("+") || "UNSPECIFIED";

  db.prepare(
    `INSERT INTO payment_holds (
      id, tenant_id, payment_ref, action, reason_code, patterns, confidence,
      thresholds_version, status, evidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`
  ).run(
    holdId,
    input.tenantId,
    input.paymentRef,
    input.action,
    reasonCode,
    JSON.stringify(input.patterns),
    input.confidence,
    ABUSE_THRESHOLDS_VERSION,
    JSON.stringify(input.evidence)
  );

  const disputeCaseId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dispute_cases (
      id, class, tenant_id, hold_id, status, evidence_bundle
    ) VALUES (?, 'payment', ?, ?, 'open', ?)`
  ).run(
    disputeCaseId,
    input.tenantId,
    holdId,
    JSON.stringify({ reasonCode, patterns: input.patterns, confidence: input.confidence, ...input.evidence })
  );

  db.prepare(`UPDATE payment_holds SET dispute_case_id = ? WHERE id = ?`).run(
    disputeCaseId,
    holdId
  );

  log("warn", "abuse_enforcement_hold_created", {
    holdId,
    disputeCaseId,
    tenantId: input.tenantId,
    action: input.action,
    reasonCode,
    confidence: input.confidence,
  });

  return { holdId, disputeCaseId };
}

export function getHold(holdId: string): PaymentHold | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM payment_holds WHERE id = ?`)
    .get(holdId) as PaymentHoldRow | undefined;
  return row ? rowToHold(row) : null;
}

export function listHolds(
  filter: { tenantId?: string; status?: HoldStatus } = {}
): PaymentHold[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.tenantId) {
    clauses.push("tenant_id = ?");
    params.push(filter.tenantId);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM payment_holds ${where} ORDER BY created_at DESC LIMIT 200`)
    .all(...params) as PaymentHoldRow[];
  return rows.map(rowToHold);
}

/**
 * Dual-control release: the first reviewer records intent (status moves to
 * pending_release); a *different* reviewer must confirm before the hold is
 * actually released and the linked dispute case resolved. A single
 * operator can never release their own hold.
 */
export function reviewHold(
  holdId: string,
  reviewerId: string,
  reason: string
): PaymentHold {
  const db = getDb();
  const hold = getHold(holdId);
  if (!hold) {
    throw new Error(`Hold ${holdId} not found`);
  }
  if (hold.status === "released") {
    throw new Error(`Hold ${holdId} is already released`);
  }

  const now = new Date().toISOString();

  if (hold.status === "held") {
    db.prepare(
      `UPDATE payment_holds
       SET status = 'pending_release', first_reviewer_id = ?, first_review_at = ?, first_review_reason = ?
       WHERE id = ?`
    ).run(reviewerId, now, reason, holdId);

    log("info", "abuse_hold_first_review", { holdId, reviewerId });
    return getHold(holdId)!;
  }

  // status === "pending_release": require a second, distinct reviewer.
  if (hold.firstReviewerId === reviewerId) {
    throw new Error(
      "Dual control violation: the second reviewer must be different from the first reviewer"
    );
  }

  db.prepare(
    `UPDATE payment_holds
     SET status = 'released', released_by = ?, released_at = ?, release_reason = ?
     WHERE id = ?`
  ).run(reviewerId, now, reason, holdId);

  if (hold.disputeCaseId) {
    db.prepare(
      `UPDATE dispute_cases SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?`
    ).run(now, reason, hold.disputeCaseId);
    // Tell subscribers the outcome (#886). Never throws into the review.
    publishNotificationEventSafely(
      notificationFromDisputeResolution({ caseId: hold.disputeCaseId, resolution: reason }),
    );
  }

  log("info", "abuse_hold_released", {
    holdId,
    firstReviewerId: hold.firstReviewerId,
    secondReviewerId: reviewerId,
  });

  return getHold(holdId)!;
}
