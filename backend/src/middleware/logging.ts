/**
 * Request Logging Middleware
 *
 * Provides request context, structured logging, and configurable sampling.
 *
 * Features:
 * - Configurable sampling rates per endpoint category
 * - Full request/response body logging for errors (4xx/5xx)
 * - Full body logging for slow requests (configurable threshold)
 * - Sensitive field redaction in logged bodies
 * - Request body logging opt-in per route
 * - Log volume metrics
 * - Trace ID correlation across all log entries
 * - Supports PII redaction via the enhanced logger
 * Provides request context and structured logging for all requests.
 * Supports PII redaction via the enhanced logger and correlation ID
 * propagation via AsyncLocalStorage so every downstream log call from
 * services/routes automatically carries the request's correlation + trace ID.
 */

import type { Request, Response, NextFunction } from "express";

// Extend Express Request to include ctx
declare global {
  namespace Express {
    interface Request {
      ctx?: string;
      traceId?: string;
      spanId?: string;
    }
  }
}
import crypto from "crypto";
// import { config } from "../config.js"; // Unused - kept for reference
import { log, hashIp, getRedactionPolicy } from "../services/logger.js";
import {
  createSpanContext,
  formatTraceparent,
  parseTraceparent,
  runWithSpanContext,
  type SpanContext,
} from "../services/tracing.js";

/**
 * Parses an inbound W3C `traceparent` header (version-traceid-parentid-flags,
 * https://www.w3.org/TR/trace-context/#traceparent-header) and returns its
 * trace ID, or `undefined` if the header is absent or malformed.
 */
export function parseIncomingTraceId(
  header: string | undefined,
): string | undefined {
  return parseTraceparent(header)?.traceId;
}

// ============================================
// LOG VOLUME METRICS
// ============================================

interface LogMetrics {
  totalRequests: number;
  sampledIn: number;
  sampledOut: number;
  bodyLogged: number;
  errorLogged: number;
  slowLogged: number;
  lastReset: number;
}

const logMetrics: LogMetrics = {
  totalRequests: 0,
  sampledIn: 0,
  sampledOut: 0,
  bodyLogged: 0,
  errorLogged: 0,
  slowLogged: 0,
  lastReset: Date.now(),
};

/**
 * Get current log metrics snapshot and optionally reset counters.
 */
export function getLogMetrics(reset = false): LogMetrics {
  const snapshot = { ...logMetrics };
  if (reset) {
    logMetrics.totalRequests = 0;
    logMetrics.sampledIn = 0;
    logMetrics.sampledOut = 0;
    logMetrics.bodyLogged = 0;
    logMetrics.errorLogged = 0;
    logMetrics.slowLogged = 0;
    logMetrics.lastReset = Date.now();
  }
  return snapshot;
}

// ============================================
// SENSITIVE FIELD REDACTION
// ============================================

/** Fields to redact from request/response bodies */
const SENSITIVE_FIELDS = new Set([
  "proof",
  "nullifier",
  "secret",
  "token",
  "password",
  "jwt",
  "authorization",
  "authorizationHeader",
  "relayerSecretKey",
  "relayerAuthToken",
  "pinataJwt",
  "web3StorageToken",
  "privateKey",
  "secretKey",
]);

/** Regex patterns for sensitive values */
const SENSITIVE_PATTERNS = [
  /^(sk_|pk_|C[A-Z2-7]{55})/, // Stellar keys and contract IDs
  /^Bearer\s+/i, // Bearer tokens
];

/**
 * Deep-clone and redact sensitive fields from a body object.
 * Returns a new object with sensitive values replaced with "[REDACTED]".
 */
function redactBody(body: unknown, maxChars: number): unknown {
  if (!body || typeof body !== "object") {
    if (typeof body === "string") {
      return body.length > maxChars ? body.slice(0, maxChars) + "...(truncated)" : body;
    }
    return body;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "string" && SENSITIVE_PATTERNS.some((p) => p.test(value))) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      redacted[key] = redactBody(value, maxChars);
    } else {
      redacted[key] = value;
    }
  }

  // Truncate the serialized result if too long
  const serialized = JSON.stringify(redacted);
  if (serialized.length > maxChars) {
    return { _truncated: true, _preview: serialized.slice(0, maxChars) + "..." };
  }

  return redacted;
}

// ============================================
// SAMPLING LOGIC
// ============================================

/**
 * Route-specific sampling overrides.
 * Map route patterns to sampling rates.
 */
const ROUTE_SAMPLING_OVERRIDES: Array<{
  pattern: RegExp;
  rate: number;
  alwaysLogBody: boolean;
}> = [
  // /vote endpoints always log at full rate with body
  { pattern: /^\/vote/, rate: 1.0, alwaysLogBody: true },
  // /comment endpoints log at higher rate
  { pattern: /^\/comment/, rate: 0.5, alwaysLogBody: false },
  // /health at low rate (noisy)
  { pattern: /^\/health/, rate: 0.01, alwaysLogBody: false },
  // /ready at low rate
  { pattern: /^\/ready/, rate: 0.05, alwaysLogBody: false },
  // /config at low rate
  { pattern: /^\/config/, rate: 0.01, alwaysLogBody: false },
  // /events at low rate
  { pattern: /^\/events/, rate: 0.05, alwaysLogBody: false },
  // /ipfs at moderate rate
  { pattern: /^\/ipfs/, rate: 0.2, alwaysLogBody: false },
  // /daos at moderate rate
  { pattern: /^\/daos/, rate: 0.1, alwaysLogBody: false },
];

/**
 * Determine whether this request should be sampled in.
 * Returns { sampled, reason } for observability.
 */
function shouldSample(
  path: string,
  statusCode: number,
  durationMs: number,
): { sampled: boolean; reason: string; rate: number } {
  // Always log errors (4xx, 5xx)
  if (statusCode >= 400) {
    return { sampled: true, reason: "error", rate: config.logSamplingErrorRate };
  }

  // Always log slow requests
  if (durationMs > config.logSlowThresholdMs) {
    return { sampled: true, reason: "slow", rate: config.logSamplingSlowRate };
  }

  // Check route-specific overrides
  for (const override of ROUTE_SAMPLING_OVERRIDES) {
    if (override.pattern.test(path)) {
      return { sampled: Math.random() < override.rate, reason: "route_override", rate: override.rate };
    }
  }

  // Use default sampling rate
  return { sampled: Math.random() < config.logSamplingRate, reason: "default", rate: config.logSamplingRate };
}

/**
 * Check if a route has body logging enabled.
 */
function shouldLogBody(path: string): boolean {
  for (const override of ROUTE_SAMPLING_OVERRIDES) {
    if (override.pattern.test(path) && override.alwaysLogBody) {
      return true;
    }
  }
  return config.logRequestBody;
}

// ============================================
// REQUEST BODY CAPTURE
// ============================================

/**
 * Capture the request body for logging.
 * Middleware must be mounted before body parsing for this to work.
 * We use a response interceptor to capture the final response.
 */
export function captureResponseBody(res: Response): { getBody: () => unknown } {
  let responseBody: unknown = undefined;

  // Intercept res.json to capture the body
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    responseBody = body;
    return originalJson(body);
  };

  return {
    getBody: () => responseBody,
  };
}

// ============================================
// MIDDLEWARE
// ============================================

/**
 * Enhanced request logging middleware with sampling and body logging.
 *
 * Features:
 * - Context ID (trace ID) for request correlation
 * - Configurable sampling rates (per-route, per-error, per-slow)
 * - Full request/response body logging for errors and slow requests
 * - Sensitive field redaction
 * - Log volume metrics
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startTime = Date.now();
  const ctx = crypto.randomBytes(6).toString("hex");
  req.ctx = ctx;

  // W3C Trace Context (#141): continue an inbound trace ID when present so
  // this request can be correlated across services, otherwise start a new
  // trace. The span ID always identifies this hop.
  const traceId =
    parseIncomingTraceId(req.get("traceparent")) ||
    crypto.randomBytes(16).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");
  req.traceId = traceId;
  res.setHeader("traceparent", `00-${traceId}-${spanId}-01`);

  // Build IP meta based on configuration
  const policy = getRedactionPolicy();
  let ipMeta: Record<string, string> = {};

  if (policy.showClientIp === "plain") {
    ipMeta = { ip: req.ip || "" };
  } else if (policy.showClientIp === "hash") {
    ipMeta = { ipHash: hashIp(req.ip) };
  }

  // Capture request body if body logging is enabled
  const requestPath = req.path || req.url;
  const logBody = shouldLogBody(requestPath);
  const requestBodyMeta: Record<string, unknown> = logBody
    ? { body: redactBody(req.body, config.logBodyMaxChars) }
    : policy.showBodyKeysOnly
      ? { bodyKeys: Object.keys(req.body || {}) }
      : {};

  // Track metrics
  logMetrics.totalRequests++;
  // If "none", ipMeta stays empty

  // Build body meta (only log body keys, not values)
  const bodyMeta = policy.showBodyKeysOnly
    ? { bodyKeys: Object.keys(req.body || {}) }
    : {};

  // Log request start (always, at info level)
  log("info", "request_start", {
    ctx,
    traceId,
    path: requestPath,
    path: req.path,
    method: req.method,
    ...ipMeta,
    ...requestBodyMeta,
    userAgent: req.get("user-agent"),
    contentLength: req.get("content-length"),
  });

  // Capture response body
  const responseCapture = captureResponseBody(res);

  // Log request end on finish
  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Determine sampling
    const { sampled, reason, rate } = shouldSample(requestPath, statusCode, durationMs);

    // Update metrics
    if (sampled) {
      logMetrics.sampledIn++;
    } else {
      logMetrics.sampledOut++;
    }

    // Build response meta
    const responseMeta: Record<string, unknown> = {
      ctx,
      traceId,
      path: requestPath,
      status: statusCode,
      durationMs,
      contentLength: res.get("content-length"),
    };

    // Log body for errors or when sampled
    const isError = statusCode >= 400;
    const isSlow = durationMs > config.logSlowThresholdMs;
    const shouldLogResponseBody = sampled || isError || isSlow;

    if (shouldLogResponseBody) {
      const responseBody = responseCapture.getBody();
      if (responseBody !== undefined) {
        responseMeta.body = redactBody(responseBody, config.logBodyMaxChars);
        logMetrics.bodyLogged++;
      }

      // Also include request body in error/slow logs for debugging
      if (logBody) {
        responseMeta.requestBody = redactBody(req.body, config.logBodyMaxChars);
      }
    }

    // Track error/slow specific metrics
    if (isError) logMetrics.errorLogged++;
    if (isSlow) logMetrics.slowLogged++;

    // Choose log level based on status code
    const level = isError ? "error" : isSlow ? "warn" : "info";

    log(level, "request_end", {
      ...responseMeta,
      sampled,
      sampleReason: reason,
      sampleRate: rate,
      path: req.path,
      method: req.method,
      ...ipMeta,
      ...bodyMeta,
    });

  runWithSpanContext(spanContext, next);
}

/**
 * Middleware to expose log metrics on a diagnostic endpoint.
 */
export function logMetricsEndpoint(
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  res.json({
    metrics: getLogMetrics(),
    config: {
      samplingRate: config.logSamplingRate,
      errorRate: config.logSamplingErrorRate,
      slowRate: config.logSamplingSlowRate,
      slowThresholdMs: config.logSlowThresholdMs,
      bodyMaxChars: config.logBodyMaxChars,
      logRequestBody: config.logRequestBody,
    },
  });
}

/**
 * Error logging middleware with redaction
 * Logs errors without exposing sensitive data
 */
export function errorLogger(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const isProduction = process.env.NODE_ENV === "production";

  // Log the error with redaction; correlation IDs are attached automatically
  // via the active request context.
  log("error", "request_error", {
    path: req.path,
    method: req.method,
    error: err.message,
    // In production, don't log stack traces
    ...(isProduction ? {} : { stack: err.stack }),
  });

  next(err);
}
