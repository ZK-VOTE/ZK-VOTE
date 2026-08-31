/**
 * Automated Error Recovery & Remediation System
 *
 * Classifies backend runtime errors, executes automated remediations,
 * manages escalation rules, tracks MTTR metrics, and maintains remediation history.
 */
import { Counter, Gauge } from "prom-client";
export type ErrorType = "RPC_CONNECTIVITY" | "RPC_RATE_LIMITED" | "SQLITE_LOCKED" | "SQLITE_CORRUPT" | "PINATA_DOWN" | "MEMORY_EXHAUSTION" | "SEQUENCE_MISMATCH" | "BACKGROUND_SERVICE_CRASH";
export type EscalationLevel = "AUTO_REMEDIATE" | "ALERT" | "PAGE";
export interface RemediationRecord {
    id: string;
    timestamp: string;
    errorType: ErrorType;
    errorMessage: string;
    escalationLevel: EscalationLevel;
    actionTaken: string;
    success: boolean;
    recoveryTimeMs: number;
    details?: Record<string, unknown>;
}
export interface MTTRStats {
    errorType: ErrorType;
    totalOccurrences: number;
    successfulRecoveries: number;
    failedRecoveries: number;
    totalRecoveryTimeMs: number;
    mttrMs: number;
}
export declare const remediationActionsTotal: Counter<"status" | "error_type" | "escalation">;
export declare const mttrGauge: Gauge<"error_type">;
export declare function setBackupRpcUrls(urls: string[]): void;
export declare function getCurrentRpcUrl(): string;
export declare function getCurrentPollingInterval(): number;
export declare function getRetryQueueLength(): number;
export declare function classifyError(error: unknown): ErrorType;
export declare function remediateError(errorType: ErrorType, error: unknown, context?: Record<string, unknown>): Promise<RemediationRecord>;
export declare function getRemediationHistory(limit?: number): RemediationRecord[];
export declare function getMTTRStats(): MTTRStats[];
export declare function clearRemediationHistory(): void;
//# sourceMappingURL=remediation.d.ts.map