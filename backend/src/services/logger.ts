/**
 * Structured Logger Service
 *
 * Provides structured JSON logging with sensitive field redaction.
 */

import crypto from "crypto";
import type { LogLevel, LogMeta } from "../types/index.js";

// ============================================
// REDACTION
// ============================================

const REDACTED_FIELDS = [
  "proof",
  "nullifier",
  "commitment",
  "secret",
  "token",
  "password",
  "jwt",
];

function redact(obj: LogMeta): LogMeta {
  const safe = { ...obj };
  for (const key of REDACTED_FIELDS) {
    if (key in safe) {
      safe[key] = "[REDACTED]";
    }
  }
  return safe;
}

// ============================================
// LOGGER
// ============================================

export interface Logger {
  log(level: LogLevel, event: string, meta?: LogMeta): void;
  debug(event: string, meta?: LogMeta): void;
  info(event: string, meta?: LogMeta): void;
  warn(event: string, meta?: LogMeta): void;
  error(event: string, meta?: LogMeta): void;
}

/**
 * Create a logger instance for a specific service
 */
export function createLogger(service: string): Logger {
  const log = (level: LogLevel, event: string, meta: LogMeta = {}): void => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service,
      event,
      ...redact(meta),
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

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * Hash an IP address for privacy
 */
export function hashIp(ip: string | undefined): string {
  return crypto
    .createHash("sha256")
    .update(ip || "")
    .digest("hex")
    .slice(0, 12);
}

// ============================================
// SIMPLE LOG FUNCTION
// ============================================

/**
 * Simple log function compatible with existing code
 */
export function log(level: LogLevel, event: string, meta: LogMeta = {}): void {
  const safe = redact(meta);
  console.log(
    JSON.stringify({ level, event, ts: new Date().toISOString(), ...safe }),
  );
}

// Default logger instance
export const logger = createLogger("relayer");
