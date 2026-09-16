/**
 * Audit Middleware - Accountability for anonymity-critical actions
 *
 * Provides append-only audit trail for mutating routes:
 * - Audit every POST/PUT/PATCH/DELETE request
 * - Redact PII (proofs, nullifiers, secrets) before storage
 * - Export & query APIs
 * - Immutable log (no update/delete)
 *
 * Used for both general audit (Task 2) and remediation accountability (Task 3)
 */
import type { Request, Response, NextFunction } from "express";
export declare const CORS_ALLOWED_METHODS: string[];
export declare const CORS_ALLOWED_HEADERS: string[];
export declare const CORS_MAX_AGE = 3600;
export declare function parseCorsOrigins(raw: string | undefined): string[];
export declare function isCorsOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean;
export declare function createCorsOptions(rawOrigins: string | undefined): {
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => void;
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
    maxAge: number;
};
export declare const REDACTED = "[REDACTED]";
/**
 * Fields that contain PII or sensitive cryptographic material.
 * Matching is case-insensitive and substring-based for nested detection.
 */
export declare const SENSITIVE_FIELDS: Set<string>;
/**
 * Deep redaction of PII fields.
 * - Redacts known sensitive keys case-insensitively
 * - Redacts entire proof object
 * - Handles nested objects, arrays, and circular references via seen set
 */
export declare function redactPii(obj: unknown, seen?: WeakSet<object>): unknown;
/**
 * Redact PII from request body for audit logging.
 * Also handles null/undefined bodies.
 */
export declare function redactBody(body: unknown): unknown;
export interface AuditEntry {
    id: string;
    timestamp: string;
    requestId: string;
    method: string;
    path: string;
    action: string;
    actor: string;
    actorIpHash?: string;
    requestBody?: unknown;
    query?: unknown;
    params?: unknown;
    statusCode?: number;
    durationMs?: number;
    userAgent?: string;
    immutable: true;
}
/**
 * Derive actor identifier without leaking PII.
 * - If auth token present, hash it (never store raw token)
 * - Else use ip hash
 * - Never store raw address or secret
 */
export declare function deriveActor(req: Request): string;
/**
 * Append-only insert. Returns entry. Never allows mutation.
 */
export declare function appendAudit(entry: Omit<AuditEntry, "id" | "timestamp" | "immutable"> & Partial<Pick<AuditEntry, "id" | "timestamp">>): AuditEntry;
/**
 * Query audit logs with filters.
 * Supports: action, actor, method, path, from, to, limit, offset
 */
export interface AuditQuery {
    action?: string;
    actor?: string;
    method?: string;
    path?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
}
export declare function queryAuditLogs(q: AuditQuery): {
    entries: AuditEntry[];
    total: number;
};
export declare function getAllAuditLogs(): AuditEntry[];
export declare function exportAuditLogs(format?: "json" | "csv"): string;
/**
 * Clear audit log - ONLY for tests. Not exposed via API.
 */
export declare function clearAuditLog(): void;
/**
 * Idempotency / replay-safe helpers
 */
export declare function isIdempotencyKeyUsed(key: string): boolean;
export declare function markIdempotencyKey(key: string): void;
export declare function clearIdempotencyKeys(): void;
/**
 * Build audit-logging middleware for a named action.
 *
 * Compatibility layer for the pre-rewrite `auditLog(action)` API used by
 * route handlers that want a per-action audit entry on a specific route
 * (e.g. `/daos/sync`) in addition to the global mutating-route audit.
 */
export declare function auditLog(action: string): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Audit middleware - should be mounted early but after body parsing.
 * Audits every mutating request (POST/PUT/PATCH/DELETE).
 * - Captures redacted body, actor, timing
 * - Appends immutable entry on response finish
 * - Never blocks request on audit failure
 */
export declare function auditMiddleware(req: Request, res: Response, next: NextFunction): void;
/**
 * Synchronous helper to manually audit an action inside route handlers.
 * Use when you need to record audit with custom action name or extra context.
 */
export declare function auditAction(req: Request, action: string, extra?: {
    body?: unknown;
    statusCode?: number;
}): AuditEntry;
//# sourceMappingURL=audit.d.ts.map