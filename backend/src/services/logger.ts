/**
 * Structured Logger Service with PII Redaction
 *
 * Provides:
 *  - Structured JSON logging to stdout
 *  - PII redaction (field- and pattern-based)
 *  - Per-request correlation context via AsyncLocalStorage so every nested
 *    log call carries the request's correlation ID + trace ID automatically
 *  - Trace sampling (`LOG_SAMPLE_RATE`) so high-volume requests can be
 *    probabilistically dropped while keeping an entire request consistent
 */

import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogMeta = Record<string, any>;

export interface RedactionPolicy {
  redactedFields: string[];
  detailedLevels: LogLevel[];
  showClientIp: "plain" | "hash" | "none";
  showBodyKeysOnly: boolean;
  stellarTruncateLength: number;
}

/**
 * Per-request correlation context. Populated by the request logging
 * middleware and propagated through AsyncLocalStorage to every nested
 * log call (services, routes, background work spawned from a request).
 */
export interface RequestContext {
  ctx: string;
  traceId: string;
  path?: string;
  method?: string;
}

const DEFAULT_POLICY: RedactionPolicy = {
  redactedFields: [
    "proof",
    "nullifier",
    "commitment",
    "secret",
    "token",
    "password",
    "jwt",
    "refresh_token",
    "access_token",
    "api_key",
    "private_key",
    "seed",
    "mnemonic",
  ],
  detailedLevels: ["debug"],
  showClientIp: "hash",
  showBodyKeysOnly: true,
  stellarTruncateLength: 4,
};

let currentPolicy: RedactionPolicy = { ...DEFAULT_POLICY };

// Correlation context store: auto-attaches request correlation IDs to every
// log call made within a request's async execution context.
const requestContextStore = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` within the given correlation context. Every log call made
 * synchronously or asynchronously (via awaited promises, timers, etc.)
 * spawned from `fn` will automatically include `ctx` and `traceId`.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStore.run(context, fn);
}

/**
 * Returns the correlation context active for the current async execution,
 * or `undefined` when no request context is present (e.g. background jobs).
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

/**
 * Trace sampling rate in [0, 1]. Defaults to 1 (log everything). Set via
 * `LOG_SAMPLE_RATE` env or `setLogSampleRate` (tests/tuning).
 */
let sampleRate: number = clampSampleRate(
  parseFloat(process.env.LOG_SAMPLE_RATE || "1"),
);

function clampSampleRate(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export function setLogSampleRate(rate: number): void {
  sampleRate = clampSampleRate(rate);
}

export function getLogSampleRate(): number {
  return sampleRate;
}

/**
 * Applies sampling deterministically keyed on the request's trace ID (or
 * correlation ID) so a single request is either fully sampled or fully
 * dropped - keeping start/end spans and nested logs consistent.
 */
function shouldEmit(event: string, meta: LogMeta): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;

  const context = getRequestContext();
  const key =
    meta.traceId ?? meta.ctx ?? context?.traceId ?? context?.ctx ?? event;

  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return (hash % 100) / 100 < sampleRate;
}

/**
 * Merges the active correlation context into the log meta so downstream
 * log calls (services/routes) automatically carry correlation IDs without
 * threading `req` manually. Explicit meta values win over context.
 */
function withCorrelation(meta: LogMeta): LogMeta {
  const context = getRequestContext();
  if (!context) return meta;
  return {
    ...meta,
    ctx: meta.ctx ?? context.ctx,
    traceId: meta.traceId ?? context.traceId,
    path: meta.path ?? context.path,
    method: meta.method ?? context.method,
  };
}

export function setRedactionPolicy(policy: Partial<RedactionPolicy>): void {
  currentPolicy = { ...currentPolicy, ...policy };
}

export function getRedactionPolicy(): RedactionPolicy {
  return { ...currentPolicy };
}

export function truncateStellarAddress(address: string): string {
  if (!address || address.length < 8) return "[REDACTED]";
  const prefix = currentPolicy.stellarTruncateLength;
  return address.slice(0, prefix) + "..." + address.slice(-prefix);
}

function applyRedaction(value: any, key: string, level: LogLevel): any {
  if (value && typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      return value.map((v) => applyRedaction(v, key, level));
    }
    const result: any = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = applyRedaction(v, k, level);
    }
    return result;
  }

  // Check if this field is in the redacted fields list
  if (
    currentPolicy.redactedFields.some(
      (f) =>
        key.toLowerCase().includes(f.toLowerCase()) ||
        f.toLowerCase().includes(key.toLowerCase()),
    )
  ) {
    return "[REDACTED]";
  }

  // For string values, apply pattern-based redaction
  if (typeof value === "string") {
    // Stellar addresses
    if (value.match(/^G[A-Z0-9]{55}$/)) {
      return truncateStellarAddress(value);
    }
    // Stellar secret keys
    if (value.match(/^S[A-Z0-9]{55}$/)) {
      return "[REDACTED_SECRET]";
    }
    // IP addresses
    if (value.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)) {
      return "[REDACTED_IP]";
    }
    // Transaction hashes (64 hex)
    if (value.match(/^[0-9a-fA-F]{64}$/)) {
      return value.slice(0, 6) + "..." + value.slice(-6);
    }
    // IPFS CIDs
    if (value.match(/^(Qm|bafy)[a-zA-Z0-9]{44,59}$/)) {
      return value.slice(0, 6) + "..." + value.slice(-6);
    }
    return value;
  }

  return value;
}

export function redact(meta: LogMeta, level: LogLevel = "info"): LogMeta {
  const isDetailed = currentPolicy.detailedLevels.includes(level);

  const safe: LogMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (
      isDetailed &&
      !currentPolicy.redactedFields.some((f) =>
        key.toLowerCase().includes(f.toLowerCase()),
      )
    ) {
      safe[key] = value;
      continue;
    }
    safe[key] = applyRedaction(value, key, level);
  }
  return safe;
}

function isEnabled(level: LogLevel): boolean {
  const minLevel = (process.env.LOG_LEVEL || "info") as LogLevel;
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  return levels.indexOf(level) >= levels.indexOf(minLevel);
}

export interface Logger {
  log(level: LogLevel, event: string, meta?: LogMeta): void;
  debug(event: string, meta?: LogMeta): void;
  info(event: string, meta?: LogMeta): void;
  warn(event: string, meta?: LogMeta): void;
  error(event: string, meta?: LogMeta): void;
}

export function createLogger(service: string): Logger {
  const log = (level: LogLevel, event: string, meta: LogMeta = {}): void => {
    if (!shouldEmit(event, meta) || !isEnabled(level)) {
      return;
    }

    const redactedMeta = redact(meta, level);
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service,
      event,
      env: process.env.NODE_ENV || "development",
      ...withCorrelation(redactedMeta),
    };
    console.log(JSON.stringify(entry));
  };

  return {
    log,
    debug: (event: string, meta?: LogMeta) => log("debug", event, meta),
    info: (event: string, meta?: LogMeta) => log("info", event, meta),
    warn: (event: string, meta?: LogMeta) => log("warn", event, meta),
    error: (event: string, meta?: LogMeta) => log("error", event, meta),
  };
}

export function generateRequestId(): string {
  return crypto.randomBytes(6).toString("hex");
}

export function hashIp(ip: string | undefined): string {
  return crypto
    .createHash("sha256")
    .update(ip || "")
    .digest("hex")
    .slice(0, 12);
}

export function log(level: LogLevel, event: string, meta: LogMeta = {}): void {
  if (!shouldEmit(event, meta) || !isEnabled(level)) {
    return;
  }

  const safe = redact(meta, level);
  console.log(
    JSON.stringify({
      level,
      event,
      ts: new Date().toISOString(),
      env: process.env.NODE_ENV || "development",
      ...withCorrelation(safe),
    }),
  );
}

export const logger = createLogger(process.env.SERVICE_NAME || "relayer");
