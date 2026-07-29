/**
 * Redis-backed Store for express-rate-limit v8.
 *
 * Implements the Store interface (increment/decrement/resetKey) atomically
 * via a Lua script (INCR + PEXPIRE-on-first-hit in one round trip), so
 * counters are shared across every Fly.io machine instead of living in
 * each process's memory.
 */

import type { Store, IncrementResponse, Options } from "express-rate-limit";
import { redis } from "../services/redisClient.js";
import { log } from "../services/logger.js";

const INCR_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if tonumber(current) == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return {current, ttl}
`;

export class RedisStore implements Store {
  private windowMs = 60_000;
  private limiterName: string;

  constructor(prefix: string) {
    this.limiterName = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private redisKey(key: string): string {
    return `rl:${this.limiterName}:${key}`;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const redisKey = this.redisKey(key);

    if (!redis) {
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }

    try {
      const [current, ttl] = (await redis.eval(
        INCR_SCRIPT,
        1,
        redisKey,
        this.windowMs,
      )) as [number, number];

      return {
        totalHits: current,
        resetTime: new Date(Date.now() + ttl),
      };
    } catch (err) {
      log("error", "rate_limit_store_error", {
        limiter: this.limiterName,
        message: (err as Error).message,
      });
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    if (!redis) return;
    try {
      await redis.decr(this.redisKey(key));
    } catch (err) {
      log("error", "rate_limit_store_error", {
        limiter: this.limiterName,
        op: "decrement",
        message: (err as Error).message,
      });
    }
  }

  async resetKey(key: string): Promise<void> {
    if (!redis) return;
    try {
      await redis.del(this.redisKey(key));
    } catch (err) {
      log("error", "rate_limit_store_error", {
        limiter: this.limiterName,
        op: "resetKey",
        message: (err as Error).message,
      });
    }
  }
}
