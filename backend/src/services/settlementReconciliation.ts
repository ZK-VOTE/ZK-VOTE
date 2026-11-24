/**
 * Settlement Reconciliation — Multi-anchor truth resolution (#720 / SPIKE-037)
 *
 * Reconciles anchor-confirmed vs chain-settled state with deterministic
 * conflict resolution, fee accounting, and dispute tracking.
 *
 * PLACEHOLDER: Requires full implementation with:
 * - Multi-anchor adapter pattern
 * - Callback-chaos tested convergence
 * - Aging-unsettled monitoring
 * - Support dispute view
 */

/**
 * Settlement state machine.
 * Terminals: settled, disputed, failed.
 */
export type SettlementStatus =
  | "pending"      // Initiated, awaiting anchor confirmation
  | "confirmed"    // Anchor confirmed, awaiting chain finality
  | "settled"      // Chain-finalized and reconciled (terminal)
  | "disputed"     // Anchor vs chain disagree (requires support)
  | "failed";      // Permanently failed (terminal)

/**
 * Fee breakdown for transparent accounting.
 */
export interface FeeBreakdown {
  /** Quoted amount user sees */
  quotedAmount: string;
  /** Anchor-side deductions (network, service, etc.) */
  anchorFees: string;
  /** On-chain tx fees */
  chainFees: string;
  /** Final settled amount */
  settledAmount: string;
  /** Currency (stroops for XLM, minor units for fiat) */
  currency: string;
}

/**
 * Canonical settlement record both anchors map into.
 * Stores both anchor-side and chain-side truth for reconciliation.
 */
export interface SettlementRecord {
  /** Unique settlement ID (generated server-side) */
  id: string;

  /** Which anchor handled this (Circle/Tempo) */
  anchor: "circle" | "tempo";

  /** Asset being settled */
  asset: "USDC" | "EURC";

  /** SEP protocol used */
  protocol: "SEP-6" | "SEP-24" | "SEP-31";

  /** Operation type */
  operation: "deposit" | "withdraw" | "send";

  /** Current settlement status */
  status: SettlementStatus;

  /** Anchor-side state */
  anchorState: {
    /** Anchor's transaction ID */
    txId: string | null;
    /** Anchor-reported status */
    status: string | null;
    /** When anchor confirmed */
    confirmedAt: number | null;
    /** Anchor-reported amount */
    amount: string | null;
  };

  /** Chain-side state */
  chainState: {
    /** Stellar transaction hash */
    txHash: string | null;
    /** Chain ledger sequence */
    ledger: number | null;
    /** When chain-finalized */
    finalizedAt: number | null;
    /** Chain-settled amount */
    amount: string | null;
    /** Memo or muxed account used */
    memo: string | null;
  };

  /** Fee breakdown */
  fees: FeeBreakdown | null;

  /** Conflict tracking (if disputed) */
  conflict: {
    /** Conflict type */
    type: ConflictType | null;
    /** Detected at timestamp */
    detectedAt: number | null;
    /** Resolution rule applied */
    resolution: string | null;
  } | null;

  /** Created timestamp */
  createdAt: number;

  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * Conflict types for deterministic resolution.
 */
export type ConflictType =
  | "amount_mismatch"      // Anchor amount ≠ chain amount
  | "memo_mismatch"        // Memo/muxed account mismatch
  | "status_divergence"    // Anchor says settled, chain says pending (or vice versa)
  | "fee_mismatch"         // Quoted fees ≠ actual deductions
  | "double_callback"      // Same anchor txId, different chain hashes
  | "missing_chain_tx"     // Anchor confirmed, no chain tx
  | "missing_anchor_conf"; // Chain settled, anchor never confirmed

/**
 * Conflict resolution rules.
 * PLACEHOLDER: Requires testing each class (#720 acceptance).
 */
export const CONFLICT_RESOLUTION_RULES: Record<ConflictType, string> = {
  amount_mismatch:
    "Chain amount is terminal truth. If delta < 1%, reconcile silently. If delta >= 1%, mark disputed for support review.",

  memo_mismatch:
    "If chain tx matches account, reconcile. If muxed mismatch or wrong memo, mark disputed — credit risk.",

  status_divergence:
    "Wait for finality timeout (5 min). If anchor says settled but chain pending after timeout, mark disputed.",

  fee_mismatch:
    "If fee delta < 0.1%, reconcile silently. If delta >= 0.1%, log and update fee breakdown. If excessive (>5%), mark disputed.",

  double_callback:
    "Idempotency key: (anchorTxId, chainHash). Accept first settlement, reject duplicates. Alert on divergent hashes.",

  missing_chain_tx:
    "Wait for chain timeout (10 min). If anchor confirmed but no chain tx after timeout, mark disputed — settlement failed.",

  missing_anchor_conf:
    "Chain tx exists but anchor never confirmed. Match by amount + memo. If exact match, reconcile. Otherwise, mark disputed.",
};

/**
 * Create a new settlement record.
 */
export function createSettlementRecord(
  anchor: "circle" | "tempo",
  asset: "USDC" | "EURC",
  protocol: "SEP-6" | "SEP-24" | "SEP-31",
  operation: "deposit" | "withdraw" | "send",
): SettlementRecord {
  const now = Date.now();
  return {
    id: `${anchor}_${asset}_${now}_${Math.random().toString(36).slice(2)}`,
    anchor,
    asset,
    protocol,
    operation,
    status: "pending",
    anchorState: {
      txId: null,
      status: null,
      confirmedAt: null,
      amount: null,
    },
    chainState: {
      txHash: null,
      ledger: null,
      finalizedAt: null,
      amount: null,
      memo: null,
    },
    fees: null,
    conflict: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update settlement record with anchor confirmation.
 */
export function updateWithAnchorConfirmation(
  record: SettlementRecord,
  anchorTxId: string,
  anchorStatus: string,
  amount: string,
): SettlementRecord {
  return {
    ...record,
    status: "confirmed",
    anchorState: {
      txId: anchorTxId,
      status: anchorStatus,
      confirmedAt: Date.now(),
      amount,
    },
    updatedAt: Date.now(),
  };
}

/**
 * Update settlement record with chain finality.
 */
export function updateWithChainFinality(
  record: SettlementRecord,
  txHash: string,
  ledger: number,
  amount: string,
  memo: string | null,
): SettlementRecord {
  return {
    ...record,
    chainState: {
      txHash,
      ledger,
      finalizedAt: Date.now(),
      amount,
      memo,
    },
    updatedAt: Date.now(),
  };
}

/**
 * Reconcile anchor and chain state.
 * Returns updated record with terminal status or conflict.
 *
 * PLACEHOLDER: Needs callback-chaos testing (#720 acceptance).
 */
export function reconcileSettlement(
  record: SettlementRecord,
): SettlementRecord {
  // Both anchor and chain must be present
  if (!record.anchorState.txId || !record.chainState.txHash) {
    return record; // Not ready for reconciliation
  }

  const anchorAmount = record.anchorState.amount || "0";
  const chainAmount = record.chainState.amount || "0";

  // Detect conflicts
  const conflicts: ConflictType[] = [];

  // Amount mismatch check
  const anchorNum = parseFloat(anchorAmount);
  const chainNum = parseFloat(chainAmount);
  if (Math.abs(anchorNum - chainNum) > 0) {
    const delta = Math.abs((anchorNum - chainNum) / anchorNum);
    if (delta >= 0.01) {
      // >= 1% mismatch
      conflicts.push("amount_mismatch");
    }
  }

  // Status divergence check (simplified)
  if (record.anchorState.status === "completed" && !record.chainState.finalizedAt) {
    conflicts.push("status_divergence");
  }

  // If conflicts detected, mark disputed
  if (conflicts.length > 0) {
    return {
      ...record,
      status: "disputed",
      conflict: {
        type: conflicts[0], // Use first conflict as primary
        detectedAt: Date.now(),
        resolution: CONFLICT_RESOLUTION_RULES[conflicts[0]],
      },
      updatedAt: Date.now(),
    };
  }

  // No conflicts - mark settled
  return {
    ...record,
    status: "settled",
    updatedAt: Date.now(),
  };
}

/**
 * Calculate fee breakdown from anchor and chain data.
 */
export function calculateFeeBreakdown(
  quotedAmount: string,
  anchorAmount: string | null,
  chainAmount: string | null,
  currency: string,
): FeeBreakdown | null {
  if (!anchorAmount || !chainAmount) return null;

  const quoted = parseFloat(quotedAmount);
  const anchor = parseFloat(anchorAmount);
  const chain = parseFloat(chainAmount);

  const anchorFees = (quoted - anchor).toFixed(7);
  const chainFees = (anchor - chain).toFixed(7);

  return {
    quotedAmount,
    anchorFees,
    chainFees,
    settledAmount: chainAmount,
    currency,
  };
}

/**
 * Check if settlement is aging (pending too long).
 * Used for alerting before user complaints.
 */
export function isAgingUnsettled(
  record: SettlementRecord,
  thresholdMs: number = 10 * 60 * 1000, // 10 minutes default
): boolean {
  if (record.status === "settled" || record.status === "failed") {
    return false; // Terminal states don't age
  }

  const age = Date.now() - record.createdAt;
  return age > thresholdMs;
}

/**
 * Get human-readable conflict description.
 */
export function getConflictDescription(conflict: ConflictType): string {
  return CONFLICT_RESOLUTION_RULES[conflict];
}
