/**
 * Audit Log Service
 *
 * Append-only, hash-chained record of privileged/administrative actions,
 * separate from the general request/response logging in middleware/logging.ts.
 * Each row's hash covers its fields plus the previous row's hash, so tampering
 * with or removing a past entry breaks the chain — detectable via
 * verifyAuditChain().
 */
import { type AuditLogInput, type AuditLogRow, type AuditLogQueryOptions } from "./db.js";
export type { AuditLogRow, AuditLogQueryOptions };
/**
 * Hash an auth token to a short, non-reversible identifier for audit records.
 * The relayer currently has a single shared token (no per-user identity), so
 * this identifies "the caller presented a valid token", not a specific user —
 * documented in API.md.
 */
export declare function hashAuthToken(token: string | undefined): string | null;
export declare function hashClientIp(ip: string | undefined): string | null;
export interface RecordAuditLogInput {
    action: string;
    endpoint: string;
    authTokenId: string | null;
    ipHash: string | null;
    requestId: string | null;
    params?: Record<string, unknown>;
    statusCode: number;
}
/**
 * Record one audit entry. Params are redacted using the same sensitive-field
 * list as the general logger, then size-capped to keep rows small.
 */
export declare function recordAuditLog(entry: RecordAuditLogInput): AuditLogRow;
export declare function getAuditLogs(options?: AuditLogQueryOptions): {
    logs: AuditLogRow[];
    total: number;
};
export interface AuditChainVerification {
    valid: boolean;
    checkedCount: number;
    brokenAtId?: number;
    reason?: string;
}
/**
 * Recompute the hash chain across every stored row (archived or not) and
 * confirm each hash matches what its fields + the previous row's hash should
 * produce. Any past edit, deletion-without-archival, or reordering surfaces
 * here as the first mismatched id.
 */
export declare function verifyAuditChain(): AuditChainVerification;
/**
 * Format audit log rows as CEF (Common Event Format) lines, for ingestion
 * into standard SIEM tooling.
 */
export declare function formatAsCef(rows: AuditLogRow[]): string;
export interface AuditRotationResult {
    archivedCount: number;
    filePath: string | null;
}
/**
 * Rotation/archival: export unarchived rows older than the retention window
 * to a compressed, timestamped JSONL file, mark them archived_at, then delete
 * them from the hot table (the append-only trigger only permits deleting rows
 * that have already been archived — see db.ts).
 */
export declare function archiveOldAuditLogs(retentionDays?: number, archiveDir?: string): AuditRotationResult;
export declare function startAuditLogRotation(intervalMs?: number): void;
export declare function stopAuditLogRotation(): void;
export type { AuditLogInput };
//# sourceMappingURL=audit.d.ts.map