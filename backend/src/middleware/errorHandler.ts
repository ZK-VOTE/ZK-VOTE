/**
 * Global Error Handler Middleware
 *
 * Catches unhandled errors and returns standardized error responses.
 */

import type {
  Request,
  Response,
  NextFunction,
  ErrorRequestHandler,
} from "express";
import { log } from "../services/logger.js";
import { ErrorCode, type StructuredError } from "../types/index.js";
import { ApiError } from "../utils/errors.js";
import { config } from "../config.js";

function getCorrelationId(req: Request): string {
  const headerCandidates = [
    req.get("x-request-id"),
    req.get("x-correlation-id"),
    typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : undefined,
    typeof req.headers["x-correlation-id"] === "string"
      ? req.headers["x-correlation-id"]
      : undefined,
    req.ctx,
  ];

  return (
    headerCandidates.find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    ) ?? "unknown"
  );
}

function sanitizeDetails(details: unknown): unknown {
  if (details === undefined || details === null) return undefined;
  if (typeof details === "string") return undefined;
  if (Array.isArray(details)) {
    return details
      .map((item) => sanitizeDetails(item))
      .filter((item) => item !== undefined);
  }
  if (typeof details === "object") {
    return Object.fromEntries(
      Object.entries(details as Record<string, unknown>).map(([key, value]) => {
        const normalizedKey = key.toLowerCase();
        const isSensitive = [
          "password",
          "secret",
          "token",
          "authorization",
          "cookie",
          "proof",
          "signature",
          "private",
          "key",
        ].some((sensitive) => normalizedKey.includes(sensitive));

        return [key, isSensitive ? "[REDACTED]" : sanitizeDetails(value)];
      }),
    );
  }

  return details;
}

function buildErrorResponse(
  statusCode: number,
  code: ErrorCode,
  message: string,
  details: unknown,
  requestId: string,
  traceId: string,
): StructuredError {
  const errorResponse: StructuredError = {
    code,
    message,
    requestId,
    traceId,
    timestamp: new Date().toISOString(),
  };

  if (!config.genericErrors && details !== undefined) {
    const sanitized = sanitizeDetails(details);
    if (sanitized !== undefined) {
      errorResponse.details = sanitized;
    }
  }

  return errorResponse;
}

/**
 * Global error handler middleware (must be last)
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const warningMessage = err instanceof Error ? err.message : "Unknown error";
  const normalizedTraceId = req.traceId ?? "unknown";

  log("error", "unhandled_error", {
    ctx: req.ctx,
    traceId: normalizedTraceId,
    path: req.path,
    message: warningMessage,
    ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
  });

  const requestId = getCorrelationId(req);

  if (err instanceof ApiError) {
    const errorResponse = buildErrorResponse(
      err.statusCode,
      err.code,
      err.message,
      err.details,
      requestId,
      normalizedTraceId,
    );

    res.status(err.statusCode).json({ error: errorResponse });
    return;
  }

  const errorResponse = buildErrorResponse(
    500,
    ErrorCode.INTERNAL_ERROR,
    "Internal server error",
    undefined,
    requestId,
    normalizedTraceId,
  );

  res.status(500).json({ error: errorResponse });
};
