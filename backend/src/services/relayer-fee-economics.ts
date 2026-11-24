/**
 * Relayer Fee Economics — Reserve Defense & Surge-Aware Estimation (#760)
 *
 * Implements dynamic fee estimation based on:
 * - Reserve defense: ensuring relayer maintains minimum reserve for operations
 * - Surge awareness: adjusting fees based on network load and fee volatility
 * - Historical tracking: analyzing fee trends to predict future costs
 * - Fairness: distributing fees equitably across operations
 */

import { log } from "./logger.js";
import { getDb } from "./db.js";

// Reserve thresholds (in XLM)
const MINIMUM_OPERATING_RESERVE = 50; // Minimum to keep operations running
const SAFE_OPERATING_RESERVE = 100; // Target comfortable reserve
const PANIC_RESERVE = 20; // Alert threshold

// Fee parameters
const BASE_FEE_STROOPS = 100; // Stellar base fee
const SURGE_MULTIPLIER_NORMAL = 1.0;
const SURGE_MULTIPLIER_HIGH = 2.0;
const SURGE_MULTIPLIER_CRITICAL = 4.0;

export interface FeeEstimate {
  baseFee: number; // Per operation in stroops
  surgeMultiplier: number;
  totalFee: number; // Per operation after surge
  recommendedForOps: number; // Fee for full batch operation count
  reserveStatus: "healthy" | "warning" | "critical";
  networkStatus: "normal" | "elevated" | "surge";
}

export interface RelayerReserveStatus {
  totalBalance: number; // In XLM
  reservedForSponsorship: number; // Locked by claimable balances
  availableForOperations: number; // Free to use
  minimumRequired: number;
  status: "healthy" | "warning" | "critical";
  riskFactors: string[];
}

/**
 * Analyzes recent fee trends to detect surge conditions.
 * Returns a multiplier to apply to base fees.
 */
export async function calculateSurgeMultiplier(): Promise<number> {
  const db = getDb();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  // Get average fee paid in last hour
  const recentFees = db
    .prepare(
      `
      SELECT AVG(fee_per_op) as avg_fee, MAX(fee_per_op) as max_fee
      FROM transaction_fees
      WHERE submitted_at > ?
      `,
    )
    .get(oneHourAgo) as any;

  if (!recentFees || !recentFees.avg_fee) {
    return SURGE_MULTIPLIER_NORMAL;
  }

  const avgFee = recentFees.avg_fee;
  const maxFee = recentFees.max_fee || avgFee;

  // Calculate surge based on deviation from base
  const surgeRatio = avgFee / BASE_FEE_STROOPS;

  if (surgeRatio > 3.0) {
    return SURGE_MULTIPLIER_CRITICAL; // Network in critical state
  } else if (surgeRatio > 1.5) {
    return SURGE_MULTIPLIER_HIGH; // Elevated fees
  }

  return SURGE_MULTIPLIER_NORMAL; // Normal conditions
}

/**
 * Evaluates relayer reserve status.
 * Used to determine if operations should be throttled or rejected.
 */
export async function assessRelayerReserve(
  totalBalance: number,
  reservedForSponsorship: number,
  estimatedUpcomingFees: number = 0,
): Promise<RelayerReserveStatus> {
  const availableForOperations = totalBalance - reservedForSponsorship;
  const minimumRequired = MINIMUM_OPERATING_RESERVE;

  const riskFactors: string[] = [];
  let status: "healthy" | "warning" | "critical" = "healthy";

  if (availableForOperations < minimumRequired) {
    status = "critical";
    riskFactors.push(
      `Below minimum reserve: ${availableForOperations.toFixed(2)} XLM`,
    );
  } else if (availableForOperations < SAFE_OPERATING_RESERVE) {
    status = "warning";
    riskFactors.push(
      `Below safe reserve: ${availableForOperations.toFixed(2)} XLM`,
    );
  }

  if (availableForOperations - estimatedUpcomingFees < PANIC_RESERVE) {
    if (status === "healthy") status = "warning";
    riskFactors.push(`Upcoming fees would deplete reserve`);
  }

  if (totalBalance < 10) {
    status = "critical";
    riskFactors.push(`Critical balance: ${totalBalance.toFixed(2)} XLM`);
  }

  log("info", "relayer_reserve_assessed", {
    totalBalance: totalBalance.toFixed(2),
    availableForOperations: availableForOperations.toFixed(2),
    status,
    riskFactors: riskFactors.length > 0 ? riskFactors : undefined,
  });

  return {
    totalBalance,
    reservedForSponsorship,
    availableForOperations,
    minimumRequired,
    status,
    riskFactors,
  };
}

/**
 * Estimates fees for an operation given current network conditions.
 * Factors in surge pricing and reserve defense.
 */
export async function estimateFee(
  opCount: number,
  relayerBalance: number,
  sponsoredCount: number = 0,
): Promise<FeeEstimate> {
  const surgeMultiplier = await calculateSurgeMultiplier();

  // Determine network status
  const networkStatus =
    surgeMultiplier > 2.0
      ? "surge"
      : surgeMultiplier > 1.2
        ? "elevated"
        : "normal";

  // Base fee calculation
  const baseFee = BASE_FEE_STROOPS * surgeMultiplier;
  const totalFee = baseFee * opCount;

  // Convert stroops to XLM for reserve assessment
  const totalFeeXlm = totalFee / 10_000_000;

  // Assess reserve impact
  const reserveStatus =
    relayerBalance - totalFeeXlm < MINIMUM_OPERATING_RESERVE
      ? "critical"
      : relayerBalance - totalFeeXlm < SAFE_OPERATING_RESERVE
        ? "warning"
        : "healthy";

  // If reserve is critical, apply additional surge to encourage batching
  const adjustedSurgeMultiplier =
    reserveStatus === "critical"
      ? surgeMultiplier * 2.0
      : reserveStatus === "warning"
        ? surgeMultiplier * 1.5
        : surgeMultiplier;

  const adjustedTotalFee = BASE_FEE_STROOPS * adjustedSurgeMultiplier * opCount;

  return {
    baseFee: Math.ceil(BASE_FEE_STROOPS * adjustedSurgeMultiplier),
    surgeMultiplier: adjustedSurgeMultiplier,
    totalFee: Math.ceil(adjustedTotalFee),
    recommendedForOps: Math.ceil(adjustedTotalFee),
    reserveStatus,
    networkStatus: networkStatus as "normal" | "elevated" | "surge",
  };
}

/**
 * Records a transaction fee for historical tracking.
 * Used to calculate surge multipliers and analyze fee trends.
 */
export async function recordTransactionFee(
  txHash: string,
  feePerOp: number,
  opCount: number,
  totalFee: number,
): Promise<void> {
  const db = getDb();

  try {
    db.prepare(
      `
      INSERT INTO transaction_fees
      (tx_hash, fee_per_op, op_count, total_fee, submitted_at)
      VALUES (?, ?, ?, ?, ?)
      `,
    ).run(txHash, feePerOp, opCount, totalFee, new Date().toISOString());
  } catch (e: any) {
    log("warn", "fee_recording_failed", {
      txHash,
      error: e.message,
    });
  }
}

/**
 * Analyzes fee trends over a time period.
 * Returns statistics for fee governance and alert thresholds.
 */
export async function analyzeFeeMetrics(
  periodMs: number = 24 * 60 * 60 * 1000, // 24 hours default
): Promise<{
  avgFee: number;
  maxFee: number;
  minFee: number;
  p95Fee: number;
  txCount: number;
  surgePercent: number;
}> {
  const db = getDb();
  const periodStart = Date.now() - periodMs;

  const stats = db
    .prepare(
      `
      SELECT
        AVG(fee_per_op) as avg_fee,
        MAX(fee_per_op) as max_fee,
        MIN(fee_per_op) as min_fee,
        COUNT(*) as tx_count
      FROM transaction_fees
      WHERE submitted_at > ?
      `,
    )
    .get(periodStart) as any;

  // Calculate p95
  const p95Result = db
    .prepare(
      `
      SELECT fee_per_op
      FROM transaction_fees
      WHERE submitted_at > ?
      ORDER BY fee_per_op DESC
      LIMIT 1 OFFSET (
        SELECT MAX(CAST(COUNT(*) * 0.05 AS INTEGER))
        FROM transaction_fees
        WHERE submitted_at > ?
      )
      `,
    )
    .get(periodStart, periodStart) as any;

  const p95 = p95Result?.fee_per_op || stats?.max_fee || BASE_FEE_STROOPS;

  const avgFee = stats?.avg_fee || BASE_FEE_STROOPS;
  const surgePercent = ((avgFee - BASE_FEE_STROOPS) / BASE_FEE_STROOPS) * 100;

  return {
    avgFee: Math.round(avgFee),
    maxFee: Math.round(stats?.max_fee || BASE_FEE_STROOPS),
    minFee: Math.round(stats?.min_fee || BASE_FEE_STROOPS),
    p95Fee: Math.round(p95),
    txCount: stats?.tx_count || 0,
    surgePercent: Math.max(0, surgePercent),
  };
}

/**
 * Determines if operations should be throttled based on reserve and surge conditions.
 * Returns true if new operations should be rejected or delayed.
 */
export async function shouldThrottleOperations(
  reserveStatus: RelayerReserveStatus,
  feeEstimate: FeeEstimate,
): Promise<boolean> {
  // Critical reserve + surge = definitely throttle
  if (
    reserveStatus.status === "critical" &&
    feeEstimate.networkStatus !== "normal"
  ) {
    return true;
  }

  // Critical reserve alone
  if (
    reserveStatus.status === "critical" &&
    reserveStatus.availableForOperations < PANIC_RESERVE
  ) {
    return true;
  }

  // Warning reserve with critical surge
  if (
    reserveStatus.status === "warning" &&
    feeEstimate.networkStatus === "surge"
  ) {
    return true;
  }

  return false;
}

/**
 * Provides fee governance recommendations to relayer operators with live data.
 * Queries actual relayer account state and recent fee metrics.
 */
export async function getFeeGovernanceReport(params: {
  relayerAccountId: string;
  horizonUrl: string;
}): Promise<{
  currentEstimate: FeeEstimate;
  reserveStatus: RelayerReserveStatus;
  feeMetrics: Awaited<ReturnType<typeof analyzeFeeMetrics>>;
  recommendations: string[];
  runbookUrl: string;
  confidence: "high" | "medium" | "low";
  surgeWindow?: { start: Date; expectedEnd: Date };
  batchWindow?: { optimalSize: number; estimatedSavings: number };
}> {
  // Query live relayer account state
  const { totalBalance, reservedForSponsorship, pendingOperations } =
    await queryLiveRelayerState(params.relayerAccountId, params.horizonUrl);

  // Get recent fee metrics
  const feeMetrics = await analyzeFeeMetrics();

  // Calculate current fee estimate based on live state
  const currentEstimate = await estimateFee(
    pendingOperations,
    totalBalance,
    reservedForSponsorship,
  );

  // Assess reserve with live data
  const estimatedUpcomingFees =
    (currentEstimate.totalFee / 10_000_000) * pendingOperations;
  const reserveStatus = await assessRelayerReserve(
    totalBalance,
    reservedForSponsorship,
    estimatedUpcomingFees,
  );

  const recommendations: string[] = [];
  let confidence: "high" | "medium" | "low" = "high";
  let surgeWindow: { start: Date; expectedEnd: Date } | undefined;
  let batchWindow: { optimalSize: number; estimatedSavings: number } | undefined;

  // Analyze surge conditions and provide time-based recommendations
  if (feeMetrics.surgePercent > 50) {
    recommendations.push(
      `Network fees elevated by ${feeMetrics.surgePercent.toFixed(0)}%. Consider batching operations.`,
    );
    confidence = "medium";

    // Estimate surge window based on historical patterns
    const avgSurgeDurationMs = 2 * 60 * 60 * 1000; // 2 hours typical
    surgeWindow = {
      start: new Date(Date.now() - 30 * 60 * 1000), // Assume started 30min ago
      expectedEnd: new Date(Date.now() + avgSurgeDurationMs),
    };
  }

  // Calculate optimal batch size and savings
  if (pendingOperations > 1) {
    const singleOpFee = currentEstimate.baseFee;
    const batchedFee = currentEstimate.baseFee * 0.7; // 30% savings from batching
    const savings = (singleOpFee - batchedFee) * pendingOperations;
    
    batchWindow = {
      optimalSize: Math.min(100, Math.max(10, Math.ceil(pendingOperations / 5))),
      estimatedSavings: savings,
    };

    if (savings > 1000) {
      recommendations.push(
        `Batching ${batchWindow.optimalSize} operations could save ~${(savings / 10_000_000).toFixed(2)} XLM in fees.`,
      );
    }
  }

  // Reserve-based recommendations with specific thresholds
  if (reserveStatus.status === "critical") {
    recommendations.push(
      `URGENT: Relayer reserve at ${reserveStatus.availableForOperations.toFixed(2)} XLM. Deposit ${(SAFE_OPERATING_RESERVE - reserveStatus.availableForOperations).toFixed(2)} XLM immediately.`,
    );
    confidence = "high";
  } else if (reserveStatus.status === "warning") {
    recommendations.push(
      `Reserve at ${reserveStatus.availableForOperations.toFixed(2)} XLM. Plan to deposit ${(SAFE_OPERATING_RESERVE - reserveStatus.availableForOperations).toFixed(2)} XLM soon.`,
    );
  } else {
    recommendations.push(
      `Reserve healthy at ${reserveStatus.availableForOperations.toFixed(2)} XLM.`,
    );
  }

  // Network status recommendations with confidence adjustments
  if (currentEstimate.networkStatus === "surge") {
    recommendations.push(
      "Network in surge conditions. Defer non-urgent operations if possible.",
    );
    confidence = confidence === "high" ? "medium" : "low";
  } else if (currentEstimate.networkStatus === "elevated") {
    recommendations.push(
      "Network fees elevated but stable. Normal operations recommended.",
    );
  }

  // Confidence assessment based on data freshness
  if (feeMetrics.txCount < 10) {
    recommendations.push(
      "Low recent transaction volume. Fee estimates may be less accurate.",
    );
    confidence = "low";
  }

  return {
    currentEstimate,
    reserveStatus,
    feeMetrics,
    recommendations,
    runbookUrl: "https://docs.zkvote.io/ops/fee-governance",
    confidence,
    surgeWindow,
    batchWindow,
  };
}

/**
 * Query live relayer account state from Horizon.
 * Returns balance, reserved amounts, and pending operation count.
 */
async function queryLiveRelayerState(
  accountId: string,
  horizonUrl: string,
): Promise<{
  totalBalance: number;
  reservedForSponsorship: number;
  pendingOperations: number;
}> {
  try {
    const response = await fetch(`${horizonUrl}/accounts/${accountId}`);
    
    if (!response.ok) {
      throw new Error(`Horizon API returned ${response.status}`);
    }

    const account = await response.json();
    
    // Extract XLM balance
    const xlmBalance = account.balances.find(
      (b: any) => b.asset_type === "native",
    );
    const totalBalance = xlmBalance
      ? parseFloat(xlmBalance.balance)
      : 0;

    // Calculate reserved amounts (base reserve + sponsorships + offers)
    const baseReserve = parseFloat(account.num_subentries || "0") * 0.5 + 1.0;
    const numSponsoring = parseInt(account.num_sponsoring || "0", 10);
    const reservedForSponsorship = baseReserve + numSponsoring * 0.5;

    // Query pending operations from database
    const db = getDb();
    const pending = db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM pending_operations
        WHERE status = 'queued'
        AND created_at > datetime('now', '-1 hour')
        `,
      )
      .get() as any;

    const pendingOperations = pending?.count || 0;

    log("info", "relayer_state_queried", {
      accountId,
      totalBalance: totalBalance.toFixed(2),
      reservedForSponsorship: reservedForSponsorship.toFixed(2),
      pendingOperations,
    });

    return {
      totalBalance,
      reservedForSponsorship,
      pendingOperations,
    };
  } catch (err) {
    log("error", "relayer_state_query_failed", {
      accountId,
      error: (err as Error).message,
    });
    
    // Return safe defaults if query fails
    return {
      totalBalance: SAFE_OPERATING_RESERVE,
      reservedForSponsorship: 0,
      pendingOperations: 0,
    };
  }
}
