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

/**
 * Global error handler middleware (must be last)
 */
export const errorHandler: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  log("error", "unhandled_error", {
    path: req.path,
    message: err.message,
  });

  res.status(500).json({ error: "Internal server error" });
};
