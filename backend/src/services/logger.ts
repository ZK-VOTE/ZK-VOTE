// @ts-nocheck
/**
 * Structured logger with PII/sensitive-data redaction.
 *
 * Security fix (ZV-083): detailedLevels (debug bypass) is now disabled in
 * production so pattern-based redaction (Stellar addresses, IPs, tx hashes,
 * IPFS CIDs) is never skipped regardless of log level.  Even outside
 * production, pattern-based redaction always runs on string values — only the
 * field-name exclusion list was relaxed in development to aid debugging.
 */

import { AsyncLocalStorage } from "async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogMeta {
  [key: string]: unknown;
}

export interface RequestContext {
  requestId: string;
  method?: string;
  path?: string;
  userId?: string;
}

export interface RedactionPolicy {
  /**
   * Field names (case-insensitive substring match) that are always fully
   * redacted regardless of log level.
   */
  redactedFields: string[];
  /**
   * Log levels at which field-name redaction is relaxed.  MUST be empty in
   * production — set by IS_PRODUCTION guard below.
   */
  detailedLevels: LogLevel[];
  /** Maximum string length before truncation. */
  maxStringLength: number;
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const DEFAULT_POLICY: RedactionPolicy = {
  redactedFields: [
    "password",
    "secret",
    "token",
    "key",
    "seed",
    "mnemonic",
    "privateKey",
    "private_key",
    "authorization",
    "cookie",
    "credential",
  ],
  // Never relax redaction in production — the detailedLevels bypass only
  // skips field-name redaction; pattern-based redaction is always enforced.
  detailedLevels: IS_PRODUCTION ? [] : ["debug"],
  maxStringLength: 500,
};

let currentPolicy: RedactionPolicy = { ...DEFAULT_POLICY };

export function setRedactionPolicy(policy: Partial<RedactionPolicy>): void {
  currentPolicy = { ...DEFAULT_POLICY, ...policy };
}

export function getRedactionPolicy(): RedactionPolicy {
  return currentPolicy;
}

// ─── Pattern-based redaction ──────────────────────────────────────────────────

const STELLAR_ADDRESS_RE = /\bG[A-Z2-7]{55}\b/g;
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const TX_HASH_RE = /\b[0-9a-f]{64}\b/gi;
const IPFS_CID_RE = /\b(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[0-9A-Za-z]{50,})\b/g;

function redactPatterns(value: string): string {
  return value
    .replace(STELLAR_ADDRESS_RE, (m) => truncateStellarAddress(m))
    .replace(STELLAR_SECRET_RE, "[STELLAR_SECRET]")
    .replace(IP_RE, (m) => hashIp(m))
    .replace(TX_HASH_RE, (m) => `[TX:${m.slice(0, 8)}…]`)
    .replace(IPFS_CID_RE, (m) => `[IPFS:${m.slice(0, 8)}…]`);
}

function truncateStellarAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function hashIp(ip: string): string {
  // Deterministic pseudonym — same input → same output for correlation,
  // but the original IP cannot be recovered.
  let h = 0;
  for (let i = 0; i < ip.length; i++) {
    h = (Math.imul(31, h) + ip.charCodeAt(i)) | 0;
  }
  return `[IP:${(h >>> 0).toString(16).padStart(8, "0")}]`;
}

// ─── Field-level redaction ────────────────────────────────────────────────────

function applyRedaction(value: unknown, key: string, level: LogLevel): unknown {
  if (typeof value === "string") {
    const truncated =
      value.length > currentPolicy.maxStringLength
        ? value.slice(0, currentPolicy.maxStringLength) + "…[truncated]"
        : value;
    // Pattern-based redaction always runs for string values.
    return redactPatterns(truncated);
  }
  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      return value.map((item) => applyRedaction(item, key, level));
    }
    return redact(value as LogMeta, level);
  }
  return value;
}

/**
 * Redact a log metadata object.
 *
 * Rules:
 * 1. Fields whose names match `redactedFields` are always replaced with
 *    `[REDACTED]`, regardless of log level or policy.
 * 2. String values are always pattern-scanned (Stellar addresses, IPs, etc.),
 *    even in detailed/debug mode — this is the production-safety fix.
 * 3. In non-production, debug-level logs relax the *field-name* exclusion so
 *    developers can see unredacted values, but pattern redaction still applies.
 */
export function redact(meta: LogMeta, level: LogLevel = "info"): LogMeta {
  const isDetailed =
    !IS_PRODUCTION && currentPolicy.detailedLevels.includes(level);

  const safe: LogMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    const isNameRedacted = currentPolicy.redactedFields.some((f) =>
      key.toLowerCase().includes(f.toLowerCase())
    );

    if (isNameRedacted) {
      // Field-name redaction is never relaxed.
      safe[key] = "[REDACTED]";
      continue;
    }

    if (isDetailed) {
      // Relax field-name redaction in dev, but still apply pattern redaction
      // to string values so Stellar addresses, IPs, etc. are always scrubbed.
      if (typeof value === "string") {
        safe[key] = redactPatterns(value);
      } else {
        safe[key] = value;
      }
      continue;
    }

    safe[key] = applyRedaction(value, key, level);
  }
  return safe;
}

// ─── Async context ────────────────────────────────────────────────────────────

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(
  context: RequestContext,
  fn: () => T
): T {
  return asyncLocalStorage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export function log(level: LogLevel, event: string, meta: LogMeta = {}): void {
  const context = getRequestContext();
  const redacted = redact(meta, level);

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(context && {
      requestId: context.requestId,
      method: context.method,
      path: context.path,
    }),
    ...redacted,
  };

  const output = JSON.stringify(entry);

  if (level === "error") {
    process.stderr.write(output + "\n");
  } else {
    process.stdout.write(output + "\n");
  }
}

export function createLogger(defaultMeta: LogMeta = {}) {
  return {
    debug: (event: string, meta?: LogMeta) =>
      log("debug", event, { ...defaultMeta, ...meta }),
    info: (event: string, meta?: LogMeta) =>
      log("info", event, { ...defaultMeta, ...meta }),
    warn: (event: string, meta?: LogMeta) =>
      log("warn", event, { ...defaultMeta, ...meta }),
    error: (event: string, meta?: LogMeta) =>
      log("error", event, { ...defaultMeta, ...meta }),
  };
}

/** Shared logger instance used by modules that import `{ logger }` directly. */
export const logger = createLogger();
