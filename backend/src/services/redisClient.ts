/**
 * Shared Redis connection for distributed rate limiting.
 *
 * Required in production/multi-instance deployments (Fly.io scales
 * `zkvote-relayer` horizontally via [http_service] auto_start_machines).
 * Each machine previously kept its own in-memory rate limit counters,
 * multiplying the effective limit by instance count (#131).
 */

import Redis from "ioredis";
import { log } from "./logger.js";

const isTestMode = process.env.RELAYER_TEST_MODE === "true";
const REDIS_URL = process.env.REDIS_URL;

if (!isTestMode && process.env.NODE_ENV === "production" && !REDIS_URL) {
  console.error(
    "[fatal] REDIS_URL is required in production for distributed rate limiting (#131)",
  );
  process.exit(1);
}

export const redis: Redis | null = REDIS_URL
  ? new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
      enableOfflineQueue: true,
      retryStrategy(times: number) {
        return Math.min(times * 200, 2000);
      },
    })
  : null;

if (redis) {
  redis.on("error", (err: Error) => {
    log("error", "redis_connection_error", { message: err.message });
  });
  redis.on("connect", () => {
    log("info", "redis_connected", {});
  });
}
