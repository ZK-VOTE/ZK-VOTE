/**
 * Abuse Detection Service - Payment Washing & Structuring Pattern Detection
 * 
 * Detects financial abuse patterns while maintaining privacy:
 * - Wash payments (self-dealing volume)
 * - Structuring (splitting to evade thresholds)
 * - Mule patterns (many accounts converging)
 * - Metadata-only analysis (never vote linkage)
 */

import { log } from "./logger.js";
import { getDb } from "./db.js";

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
} as const;

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
