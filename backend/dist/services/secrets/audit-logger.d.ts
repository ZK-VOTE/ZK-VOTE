/**
 * Secret Access Audit Logger
 *
 * Records every access to secrets for audit trail purposes.
 * Logs are structured JSON entries that include timestamp,
 * secret key, operation type, success status, and request ID.
 */
import type { AuditEntry } from "./types.js";
/**
 * Record a secret access event in the audit log
 */
export declare function auditLog(entry: AuditEntry): void;
/**
 * Create an audit entry for a secret access event
 */
export declare function createAuditEntry(secretKey: string, operation: AuditEntry["operation"], success: boolean, requestId?: string, source?: string, error?: string): AuditEntry;
//# sourceMappingURL=audit-logger.d.ts.map