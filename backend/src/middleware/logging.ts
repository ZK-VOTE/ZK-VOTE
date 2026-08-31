/**
 * Request Logging Middleware
 *
 * Provides request context and structured logging for all requests.
 * Supports PII redaction via the enhanced logger and correlation ID
 * propagation via AsyncLocalStorage so every downstream log call from
 * services/routes automatically carries the request's correlation + trace ID.
 */

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import {
  log,
  hashIp,
  getRedactionPolicy,
  runWithContext,
  type RequestContext,
} from "../services/logger.js";

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/**
 * Parses an inbound W3C `traceparent` header (version-traceid-parentid-flags,
 * https://www.w3.org/TR/trace-context/#traceparent-header) and returns its
 * trace ID, or `undefined` if the header is absent or malformed.
 */
export function parseIncomingTraceId(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return undefined;
  const traceId = match[2];
  // An all-zero trace ID is explicitly invalid per the spec.
  if (/^0+$/.test(traceId)) return undefined;
  return traceId;
}

/**
 * Builds the correlation context for a request and runs the downstream
 * middleware chain within it, so every nested log call (routes, services)
 * automatically inherits the request's correlation + trace ID.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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

  const context: RequestContext = {
    ctx,
    traceId,
    path: req.path,
    method: req.method,
  };

  runWithContext(context, () => {
    // Build IP meta based on configuration
    const policy = getRedactionPolicy();
    let ipMeta: Record<string, string> = {};

    if (policy.showClientIp === "plain") {
      ipMeta = { ip: req.ip || "" };
    } else if (policy.showClientIp === "hash") {
      ipMeta = { ipHash: hashIp(req.ip) };
    }
    // If "none", ipMeta stays empty

    // Build body meta (only log body keys, not values)
    const bodyMeta = policy.showBodyKeysOnly
      ? { bodyKeys: Object.keys(req.body || {}) }
      : {};

    log("info", "request_start", {
      path: req.path,
      method: req.method,
      ...ipMeta,
      ...bodyMeta,
    });

    // Log request end on finish. The finish listener is registered within
    // the correlation context, so it inherits the same ctx/traceId.
    res.on("finish", () => {
      log("info", "request_end", {
        path: req.path,
        status: res.statusCode,
      });
    });

    next();
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
