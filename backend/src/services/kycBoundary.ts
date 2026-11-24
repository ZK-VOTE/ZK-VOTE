/**
 * KYC Boundary Service - Data Minimization & Access Control
 * 
 * Ensures KYC-adjacent data from anchors follows strict minimization:
 * - Status-only ingestion (pass/fail/pending + reason codes)
 * - No identity documents or detailed anchor metadata
 * - Field-level access control
 * - Auto-purge retention policy
 */

import { log } from "./logger.js";

/**
 * Allowed KYC status values from anchor responses
 */
export type KYCStatus = 
  | "completed" 
  | "pending_anchor" 
  | "pending_user_transfer_start" 
  | "pending_external" 
  | "error" 
  | "incomplete";

/**
 * Allowed KYC reason codes (coarse-grained, no PII)
 */
export type KYCReasonCode =
  | "kyc_required"
  | "verification_in_progress"
  | "transfer_pending"
  | "insufficient_info"
  | "unknown_error";

/**
 * Minimized KYC state - only status and reason code
 */
export interface MinimizedKYCState {
  status: KYCStatus;
  reasonCode?: KYCReasonCode;
  // Interactive URL for user action (validated separately)
  interactiveUrl?: string;
  interactiveOrigin?: string;
  // Timestamp for retention policy
  timestamp: number;
}

/**
 * Role-based access levels for KYC-adjacent data
 */
export enum KYCAccessLevel {
  NONE = 0,        // No access
  STATUS_ONLY = 1, // Can see pass/fail status
  REASON_CODE = 2, // Can see status + reason codes
  FULL = 3         // Can see all minimized fields (ops/support only)
}

/**
 * Retention horizons for KYC-adjacent data (milliseconds)
 */
export const KYC_RETENTION = {
  // Completed transactions: 90 days (compliance minimum)
  COMPLETED: 90 * 24 * 60 * 60 * 1000,
  // Pending transactions: 30 days (user has time to complete)
  PENDING: 30 * 24 * 60 * 60 * 1000,
  // Failed transactions: 7 days (user can retry)
  FAILED: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Parser-level schema enforcement: reject unknown KYC fields
 * 
 * This is the critical boundary - only status and reason code pass through.
 * All other anchor response fields (documents, metadata, etc.) are dropped.
 */
export function minimizeKYCResponse(
  anchorResponse: Record<string, unknown>
): MinimizedKYCState {
  // Map anchor status to our minimized enum
  const rawStatus = anchorResponse.status || anchorResponse.transaction_status;
  let status: KYCStatus;
  
  switch (rawStatus) {
    case "completed":
      status = "completed";
      break;
    case "pending_anchor":
    case "pending_trust":
    case "pending_user":
      status = "pending_anchor";
      break;
    case "pending_user_transfer_start":
      status = "pending_user_transfer_start";
      break;
    case "pending_external":
    case "pending_stellar":
      status = "pending_external";
      break;
    case "error":
    case "no_market":
    case "too_small":
    case "too_large":
      status = "error";
      break;
    case "incomplete":
    default:
      status = "incomplete";
      break;
  }

  // Map error messages to coarse-grained reason codes (no PII)
  let reasonCode: KYCReasonCode | undefined;
  if (anchorResponse.message || anchorResponse.error) {
    const msg = String(anchorResponse.message || anchorResponse.error).toLowerCase();
    if (msg.includes("kyc") || msg.includes("verification")) {
      reasonCode = "kyc_required";
    } else if (msg.includes("pending") || msg.includes("progress")) {
      reasonCode = "verification_in_progress";
    } else if (msg.includes("transfer")) {
      reasonCode = "transfer_pending";
    } else if (msg.includes("info") || msg.includes("data")) {
      reasonCode = "insufficient_info";
    } else {
      reasonCode = "unknown_error";
    }
  }

  const minimized: MinimizedKYCState = {
    status,
    reasonCode,
    timestamp: Date.now(),
  };

  // Preserve interactive URL if present (already validated by anchor.ts)
  if (anchorResponse.interactiveUrl) {
    minimized.interactiveUrl = String(anchorResponse.interactiveUrl);
  }
  if (anchorResponse.interactiveOrigin) {
    minimized.interactiveOrigin = String(anchorResponse.interactiveOrigin);
  }

  log("info", "kyc_data_minimized", {
    originalFieldCount: Object.keys(anchorResponse).length,
    minimizedFieldCount: Object.keys(minimized).length,
    status: minimized.status,
    reasonCode: minimized.reasonCode,
  });

  return minimized;
}

/**
 * Check if user has access to specific KYC field based on role
 */
export function checkKYCAccess(
  field: keyof MinimizedKYCState,
  accessLevel: KYCAccessLevel
): boolean {
  switch (field) {
    case "status":
      return accessLevel >= KYCAccessLevel.STATUS_ONLY;
    case "reasonCode":
      return accessLevel >= KYCAccessLevel.REASON_CODE;
    case "interactiveUrl":
    case "interactiveOrigin":
    case "timestamp":
      return accessLevel >= KYCAccessLevel.FULL;
    default:
      return false;
  }
}

/**
 * Filter KYC state based on access level
 */
export function filterKYCByAccess(
  state: MinimizedKYCState,
  accessLevel: KYCAccessLevel
): Partial<MinimizedKYCState> {
  const filtered: Partial<MinimizedKYCState> = {};
  
  for (const key of Object.keys(state) as Array<keyof MinimizedKYCState>) {
    if (checkKYCAccess(key, accessLevel)) {
      filtered[key] = state[key];
    }
  }
  
  return filtered;
}

/**
 * Determine retention horizon based on KYC status
 */
export function getRetentionHorizon(status: KYCStatus): number {
  switch (status) {
    case "completed":
      return KYC_RETENTION.COMPLETED;
    case "pending_anchor":
    case "pending_user_transfer_start":
    case "pending_external":
      return KYC_RETENTION.PENDING;
    case "error":
    case "incomplete":
      return KYC_RETENTION.FAILED;
    default:
      return KYC_RETENTION.FAILED;
  }
}

/**
 * Check if KYC state should be purged based on retention policy
 */
export function shouldPurgeKYCState(state: MinimizedKYCState): boolean {
  const horizon = getRetentionHorizon(state.status);
  const age = Date.now() - state.timestamp;
  return age > horizon;
}

/**
 * Validate that anchor response contains only minimized fields
 * Throws if excess fields detected (security boundary enforcement)
 */
export function enforceMinimizationBoundary(
  response: Record<string, unknown>
): void {
  const allowedFields = new Set([
    "status",
    "transaction_status",
    "message",
    "error",
    "interactiveUrl",
    "interactiveOrigin",
    "type",
    "url",
    "interactive_url",
  ]);

  const excessFields = Object.keys(response).filter(
    key => !allowedFields.has(key)
  );

  if (excessFields.length > 0) {
    // Never log field names or values: an anchor may choose a PII-bearing or
    // tracking-token field name. Counts are sufficient for operational review.
    log("warn", "kyc_excess_fields_rejected", {
      excessFieldCount: excessFields.length,
      responseFieldCount: Object.keys(response).length,
    });
    // Fail closed in every environment. New fields require explicit review.
    throw new Error("Anchor response contains fields outside the minimized KYC schema");
  }
}
