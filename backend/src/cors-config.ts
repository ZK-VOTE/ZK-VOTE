/**
 * CORS Configuration & Utilities
 */

import type { CorsOptions } from "cors";
import { config } from "./config.js";

/**
 * Parse and return the list of allowed CORS origins.
 */
export function getAllowedOrigins(input?: string | string[]): string[] {
  if (input === undefined) {
    if (config?.corsOrigin) {
      return getAllowedOrigins(config.corsOrigin);
    }
    return ["*"];
  }

  if (Array.isArray(input)) {
    return input.map((s) => s.trim()).filter(Boolean);
  }

  if (typeof input === "string") {
    if (!input.trim()) return [];
    return input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return ["*"];
}

/**
 * Create CORS options with origin validator function.
 */
export function createCorsOptions(
  allowed?: string[] | string,
): CorsOptions {
  const origins = getAllowedOrigins(allowed);

  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) {
        return callback(null, true);
      }

      if (origins.includes("*")) {
        return callback(null, true);
      }

      if (origins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "X-CSRF-Token",
      "X-Idempotency-Key",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
    ],
  };
}
