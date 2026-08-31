/**
 * priorityMiddleware.ts
 * -----------------------------------------------------------------------
 * Express middleware implementing:
 *   - Request priority assignment (via priorityConfig.classifyRequest)
 *   - Priority-based rate limiting (higher limits for critical operations)
 *   - Routing each request through the shared PriorityQueue so vote
 *     submissions are never blocked by read-heavy lower-tier traffic
 *
 * USAGE in your Express app:
 *
 *   import { priorityMiddleware } from "./priority/priorityMiddleware";
 *   app.use(priorityMiddleware());
 *   // ... existing route handlers unchanged below this line ...
 * -----------------------------------------------------------------------
 */

import type { Request, Response, NextFunction } from "express";
import { classifyRequest, PriorityTier, TIER_SETTINGS } from "./priorityConfig";
import { globalPriorityQueue, RequestTimeoutError } from "./priorityQueue";

// ---- simple in-memory sliding-window rate limiter, per tier ----------

interface Window {
  count: number;
  windowStart: number;
}

const windows: Record<PriorityTier, Window> = {
  [PriorityTier.CRITICAL]: { count: 0, windowStart: Date.now() },
  [PriorityTier.HIGH]: { count: 0, windowStart: Date.now() },
  [PriorityTier.MEDIUM]: { count: 0, windowStart: Date.now() },
  [PriorityTier.LOW]: { count: 0, windowStart: Date.now() },
};

function isRateLimited(tier: PriorityTier): boolean {
  const settings = TIER_SETTINGS[tier].rateLimit;
  const w = windows[tier];
  const now = Date.now();

  if (now - w.windowStart > settings.windowMs) {
    w.windowStart = now;
    w.count = 0;
  }

  w.count++;
  return w.count > settings.max;
}

// -----------------------------------------------------------------------

export interface PriorityRequest extends Request {
  priorityTier?: PriorityTier;
}

export function priorityMiddleware() {
  return (req: PriorityRequest, res: Response, next: NextFunction) => {
    const tier = classifyRequest(req.method, req.path);
    req.priorityTier = tier;
    res.setHeader("X-Priority-Tier", tier);

    if (isRateLimited(tier)) {
      res.status(429).json({
        error: "rate_limited",
        tier,
        message: `Rate limit exceeded for ${tier} tier. Try again shortly.`,
      });
      return;
    }

    // Wrap the rest of the middleware/handler chain as a single queued
    // unit of work for this tier. `next()` normally hands control to the
    // next handler synchronously; here we defer that hand-off until the
    // queue admits this request, and resolve once the response finishes.
    const runChain = () =>
      new Promise<void>((resolve, reject) => {
        res.once("finish", resolve);
        res.once("close", resolve);
        res.once("error", reject);
        try {
          next();
        } catch (err) {
          reject(err);
        }
      });

    globalPriorityQueue.enqueue(tier, runChain).catch((err) => {
      if (err instanceof RequestTimeoutError) {
        if (!res.headersSent) {
          res.status(503).json({
            error: "queue_timeout",
            tier,
            message: err.message,
          });
        }
        return;
      }
      // Only forward unexpected errors if the response hasn't already
      // been handled downstream.
      if (!res.headersSent) {
        next(err);
      }
    });
  };
}
