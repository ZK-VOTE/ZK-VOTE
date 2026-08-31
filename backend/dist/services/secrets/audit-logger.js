/**
 * Secret Access Audit Logger
 *
 * Records every access to secrets for audit trail purposes.
 * Logs are structured JSON entries that include timestamp,
 * secret key, operation type, success status, and request ID.
 */
import { createLogger } from "../logger.js";
const auditLogger = createLogger("secrets-audit");
/**
 * Record a secret access event in the audit log
 */
export function auditLog(entry) {
    auditLogger.info("secret_access", {
        secretKey: entry.secretKey,
        operation: entry.operation,
        success: entry.success,
        requestId: entry.requestId,
        source: entry.source,
        error: entry.error,
    });
}
/**
 * Create an audit entry for a secret access event
 */
export function createAuditEntry(secretKey, operation, success, requestId, source, error) {
    return {
        timestamp: new Date().toISOString(),
        secretKey,
        operation,
        success,
        requestId,
        source,
        error,
    };
}
//# sourceMappingURL=audit-logger.js.map