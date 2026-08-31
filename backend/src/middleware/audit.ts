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
import crypto from "crypto";
import { hashIp } from "../services/logger.js";

// ============================================
// REDACTION - PII protection
// ============================================

export const REDACTED = "[REDACTED]";

/**
 * Fields that contain PII or sensitive cryptographic material.
 * Matching is case-insensitive and substring-based for nested detection.
 */
export const SENSITIVE_FIELDS = new Set([
  "proof",
  "nullifier",
  "root",
  "commitment",
  "secret",
  "password",
  "jwt",
  "token",
  "privatekey",
  "private_key",
  "seed",
  "signature",
  "authorization",
  "x-relayer-auth",
  "x-relayer-token",
  "relayerauth",
  "a",
  "b",
  "c", // proof components - only redact when inside proof object
]);

/**
 * Fields that are always redacted regardless of context (top-level and nested)
 */
const ALWAYS_REDACT = new Set([
  "proof",
  "nullifier",
  "root",
  "commitment",
  "secret",
  "password",
  "jwt",
  "token",
  "privatekey",
  "private_key",
  "seed",
  "signature",
  "authorization",
  "x-relayer-auth",
]);

/**
 * Deep redaction of PII fields.
 * - Redacts known sensitive keys case-insensitively
 * - Redacts entire proof object
 * - Handles nested objects, arrays, and circular references via seen set
 */
export function redactPii(obj: unknown, seen = new WeakSet<object>()): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  // Prevent circular recursion
  if (seen.has(obj as object)) return REDACTED;
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    return obj.map((item) => redactPii(item, seen));
  }

  const input = obj as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase().replace(/[-_]/g, "");

    if (ALWAYS_REDACT.has(lower) || lower === "proof") {
      // Proof object itself or sensitive field - redact entire value
      if (key.toLowerCase() === "proof" && typeof value === "object" && value !== null) {
        output[key] = REDACTED;
      } else {
        // For primitives or nested sensitive fields
        output[key] = REDACTED;
      }
      continue;
    }

    // Special handling: proof sub-fields a,b,c only redacted when parent was proof
    // But we already redacted whole proof object above, so children won't be visited
    // For safety, if key is exactly 'proof' we already handled

    if (value !== null && typeof value === "object") {
      // Recurse but detect if current key is proof-related
      // If we're inside a proof object we would have already redacted, so this is for other nested objects
      output[key] = redactPii(value, seen);
    } else {
      output[key] = value;
    }
  }

  return output;
}

/**
 * Redact PII from request body for audit logging.
 * Also handles null/undefined bodies.
 */
export function redactBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  return redactPii(body);
}

// ============================================
// AUDIT STORE - append-only, immutable
// ============================================

export interface AuditEntry {
  id: string; // uuid or increment
  timestamp: string; // ISO
  requestId: string;
  method: string;
  path: string;
  action: string; // e.g. "vote", "comment", "bridge", "ipfs", "remediation"
  actor: string; // hashed token or ip hash (never raw PII)
  actorIpHash?: string;
  requestBody?: unknown; // redacted
  query?: unknown;
  params?: unknown;
  statusCode?: number;
  durationMs?: number;
  userAgent?: string;
  immutable: true; // flag to indicate append-only
}

let auditStore: AuditEntry[] = [];
let auditCounter = 0;
const MAX_AUDIT_LOG_SIZE = 10000;

// In-memory idempotency store for replay protection (remediation uses it too)
const idempotencyKeys = new Set<string>();

/**
 * Derive actor identifier without leaking PII.
 * - If auth token present, hash it (never store raw token)
 * - Else use ip hash
 * - Never store raw address or secret
 */
export function deriveActor(req: Request): string {
  const authHeader = (req.headers["x-relayer-auth"] || req.headers["authorization"]) as string | undefined;
  let token: string | undefined;
  if (authHeader) {
    token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  }
  if (token) {
    return `token:${crypto.createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  }
  // fallback to ip hash for unauthenticated (though mutating routes require auth)
  return `ip:${hashIp(req.ip)}`;
}

function inferAction(path: string, method: string): string {
  if (!path) return `${method}:unknown`;
  // Normalize path for action naming
  if (path.includes("/vote") || path === "/vote") return "vote";
  if (path.includes("/comment")) return "comment";
  if (path.includes("/bridge")) return "bridge";
  if (path.includes("/ipfs")) return "ipfs";
  if (path.includes("/daos/sync")) return "dao_sync";
  if (path.includes("/events")) return "indexer_event";
  if (path.includes("/remediation")) return "remediation";
  if (path.includes("/daos")) return "dao";
  if (path.includes("/audit")) return "audit_query";
  return `${method}:${path}`;
}

/**
 * Append-only insert. Returns entry. Never allows mutation.
 */
export function appendAudit(entry: Omit<AuditEntry, "id" | "timestamp" | "immutable"> & Partial<Pick<AuditEntry, "id" | "timestamp">>): AuditEntry {
  const full: AuditEntry = {
    id: entry.id || `${Date.now()}-${++auditCounter}-${crypto.randomBytes(4).toString("hex")}`,
    timestamp: entry.timestamp || new Date().toISOString(),
    requestId: entry.requestId || crypto.randomBytes(6).toString("hex"),
    method: entry.method,
    path: entry.path,
    action: entry.action || inferAction(entry.path, entry.method),
    actor: entry.actor,
    actorIpHash: entry.actorIpHash,
    requestBody: entry.requestBody !== undefined ? redactBody(entry.requestBody) : undefined,
    query: entry.query ? (redactPii(entry.query) as unknown) : undefined,
    params: entry.params ? (redactPii(entry.params) as unknown) : undefined,
    statusCode: entry.statusCode,
    durationMs: entry.durationMs,
    userAgent: entry.userAgent,
    immutable: true as const,
  };

  // Enforce append-only: push only, never splice outside this module
  auditStore.push(full);
  // Evict oldest if over capacity (still append-only, just bounding memory)
  if (auditStore.length > MAX_AUDIT_LOG_SIZE) {
    auditStore.shift();
  }

  // Also log to structured logger (redacted)
  // Use dynamic import to avoid cycle? Direct console for now
  return full;
}

/**
 * Query audit logs with filters.
 * Supports: action, actor, method, path, from, to, limit, offset
 */
export interface AuditQuery {
  action?: string;
  actor?: string;
  method?: string;
  path?: string;
  from?: string; // ISO date
  to?: string;
  limit?: number;
  offset?: number;
}

export function queryAuditLogs(q: AuditQuery): { entries: AuditEntry[]; total: number } {
  let filtered = auditStore;

  if (q.action) {
    filtered = filtered.filter((e) => e.action === q.action || e.action.includes(q.action!));
  }
  if (q.actor) {
    filtered = filtered.filter((e) => e.actor === q.actor);
  }
  if (q.method) {
    filtered = filtered.filter((e) => e.method === q.method);
  }
  if (q.path) {
    filtered = filtered.filter((e) => e.path.includes(q.path!));
  }
  if (q.from) {
    const from = new Date(q.from).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= from);
  }
  if (q.to) {
    const to = new Date(q.to).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() <= to);
  }

  const total = filtered.length;
  const offset = Math.max(0, q.offset || 0);
  const limit = Math.min(Math.max(1, q.limit || 50), 100);

  const entries = filtered.slice(offset, offset + limit);
  return { entries, total };
}

export function getAllAuditLogs(): AuditEntry[] {
  // Return shallow copy to prevent external mutation; entries themselves are immutable by convention
  return [...auditStore];
}

export function exportAuditLogs(format: "json" | "csv" = "json"): string {
  if (format === "csv") {
    const header = "id,timestamp,requestId,method,path,action,actor,statusCode,durationMs";
    const rows = auditStore.map((e) =>
      [e.id, e.timestamp, e.requestId, e.method, e.path, e.action, e.actor, e.statusCode ?? "", e.durationMs ?? ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );
    return [header, ...rows].join("\n");
  }
  return JSON.stringify(auditStore, null, 2);
}

/**
 * Clear audit log - ONLY for tests. Not exposed via API.
 */
export function clearAuditLog(): void {
  auditStore = [];
  auditCounter = 0;
  idempotencyKeys.clear();
}

/**
 * Idempotency / replay-safe helpers
 */
export function isIdempotencyKeyUsed(key: string): boolean {
  return idempotencyKeys.has(key);
}
export function markIdempotencyKey(key: string): void {
  idempotencyKeys.add(key);
}
export function clearIdempotencyKeys(): void {
  idempotencyKeys.clear();
}

// ============================================
// MIDDLEWARE
// ============================================

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Build audit-logging middleware for a named action.
 *
 * Compatibility layer for the pre-rewrite `auditLog(action)` API used by
 * route handlers that want a per-action audit entry on a specific route
 * (e.g. `/daos/sync`) in addition to the global mutating-route audit.
 */
export function auditLog(action: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on("finish", () => {
      try {
        appendAudit({
          requestId: (req as any).ctx || crypto.randomBytes(6).toString("hex"),
          method: req.method,
          path: req.path,
          action,
          actor: deriveActor(req),
          actorIpHash: hashIp(req.ip),
          requestBody: req.body ? (redactBody(req.body) as unknown) : undefined,
          query: req.query ? (redactPii({ ...req.query }) as unknown) : undefined,
          params: req.params ? (redactPii({ ...req.params }) as unknown) : undefined,
          statusCode: res.statusCode,
          userAgent: (req.headers["user-agent"] as string) || undefined,
        });
      } catch {
        // Never block the request on audit failure.
      }
    });
    next();
  };
}

/**
 * Audit middleware - should be mounted early but after body parsing.
 * Audits every mutating request (POST/PUT/PATCH/DELETE).
 * - Captures redacted body, actor, timing
 * - Appends immutable entry on response finish
 * - Never blocks request on audit failure
 */
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only audit mutating methods; but also allow explicit opt-in via header for testing
  const shouldAudit = MUTATING_METHODS.has(req.method);
  if (!shouldAudit) {
    return next();
  }

  const start = Date.now();
  const requestId = (req as any).ctx || crypto.randomBytes(6).toString("hex");
  // Capture redacted body snapshot at request time (body already parsed)
  const redactedBody = req.body ? (redactBody(req.body) as unknown) : undefined;
  const redactedQuery = req.query ? (redactPii({ ...req.query }) as unknown) : undefined;
  const redactedParams = req.params ? (redactPii({ ...req.params }) as unknown) : undefined;
  const actor = deriveActor(req);
  const ipHash = hashIp(req.ip);

  // Hook into finish to capture statusCode and duration
  res.on("finish", () => {
    try {
      appendAudit({
        requestId,
        method: req.method,
        path: req.path || req.originalUrl?.split("?")[0] || "unknown",
        action: inferAction(req.path || req.originalUrl || "", req.method),
        actor,
        actorIpHash: ipHash,
        requestBody: redactedBody,
        query: redactedQuery,
        params: redactedParams,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        userAgent: (req.headers["user-agent"] as string) || undefined,
      });
    } catch (_e) {
      // Never fail request due to audit error; log warning if possible
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({ level: "warn", event: "audit_append_failed" }));
    }
  });

  next();
}

/**
 * Synchronous helper to manually audit an action inside route handlers.
 * Use when you need to record audit with custom action name or extra context.
 */
export function auditLog(action: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    auditAction(req, action);
    next();
  };
}

export function auditAction(
  req: Request,
  action: string,
  extra?: { body?: unknown; statusCode?: number }
): AuditEntry {
  const actor = deriveActor(req);
  return appendAudit({
    requestId: (req as any).ctx || crypto.randomBytes(6).toString("hex"),
    method: req.method,
    path: req.path,
    action,
    actor,
    actorIpHash: hashIp(req.ip),
    requestBody: extra?.body !== undefined ? redactBody(extra.body) : req.body ? redactBody(req.body) : undefined,
    query: req.query ? (redactPii({ ...req.query }) as unknown) : undefined,
    params: req.params ? (redactPii({ ...req.params }) as unknown) : undefined,
    statusCode: extra?.statusCode,
    userAgent: (req.headers["user-agent"] as string) || undefined,
  });
}

/**
 * Route-level audit middleware factory. Attaches an immutable, redacted audit
 * entry for the named action when the response finishes, then continues.
 * Used by route modules as `auditLog("vote")`.
 */
export function auditLog(
  action: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on("finish", () => {
      try {
        auditAction(req, action, { statusCode: res.statusCode });
      } catch (_e) {
        // Never fail the request because auditing failed.
      }
    });
    next();
  };
}
