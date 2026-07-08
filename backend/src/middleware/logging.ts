/**
 * Request Logging Middleware
 *
 * Provides request context and structured logging for all requests.
 */

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { config } from "../config.js";
import { log } from "../services/logger.js";

/**
 * Request logging middleware
 * Adds context ID and logs request start/end
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ctx = crypto.randomBytes(6).toString("hex");
  req.ctx = ctx;

  // Build IP meta based on configuration
  const ipMeta: Record<string, string> =
    config.logClientIp === "plain"
      ? { ip: req.ip || "" }
      : config.logClientIp === "hash"
        ? {
            ipHash: crypto
              .createHash("sha256")
              .update(req.ip || "")
              .digest("hex")
              .slice(0, 12),
          }
        : {};

  // Build body meta (optionally log body keys)
  const bodyMeta = config.logRequestBody
    ? { bodyKeys: Object.keys(req.body || {}) }
    : {};

  log("info", "request_start", {
    ctx,
    path: req.path,
    method: req.method,
    ...ipMeta,
    ...bodyMeta,
  });

  // Log request end on finish
  res.on("finish", () => {
    log("info", "request_end", {
      ctx,
      path: req.path,
      status: res.statusCode,
    });
  });

  next();
}
