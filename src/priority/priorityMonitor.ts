/**
 * priorityMonitor.ts
 * -----------------------------------------------------------------------
 * "Monitor queue depth per priority tier" acceptance criterion.
 *
 * USAGE:
 *   import { priorityMetricsHandler } from "./priority/priorityMonitor";
 *   app.get("/internal/queue-metrics", priorityMetricsHandler);
 *
 * Wire this behind your existing internal-only / auth-gated router if
 * you don't want it publicly exposed.
 * -----------------------------------------------------------------------
 */

import type { Request, Response } from "express";
import { globalPriorityQueue } from "./priorityQueue";

export function priorityMetricsHandler(_req: Request, res: Response) {
  const depths = globalPriorityQueue.getQueueDepths();
  res.json({
    timestamp: new Date().toISOString(),
    tiers: depths,
  });
}

/**
 * Optional: log a warning if any tier's queue depth crosses a threshold,
 * for hooking into existing logging/alerting (e.g. call this on an
 * interval with setInterval(() => checkQueueHealth(), 10_000)).
 */
export function checkQueueHealth(warnThreshold = 50) {
  const depths = globalPriorityQueue.getQueueDepths();
  for (const d of depths) {
    if (d.queued > warnThreshold) {
      // eslint-disable-next-line no-console
      console.warn(
        `[priority-queue] ${d.tier} queue depth is ${d.queued} (threshold ${warnThreshold}), ` +
          `${d.inFlight}/${d.concurrency} workers busy`
      );
    }
  }
  return depths;
}
