/**
 * compressionMetricsRoute.ts
 * -----------------------------------------------------------------------
 * Exposes aggregate compression metrics.
 *
 * USAGE:
 *   import { compressionMetricsHandler } from "./middleware/compressionMetricsRoute";
 *   app.get("/internal/compression-metrics", compressionMetricsHandler);
 * -----------------------------------------------------------------------
 */

import type { Request, Response } from "express";
import { compressionMetrics } from "./compressionMetrics";

export function compressionMetricsHandler(_req: Request, res: Response) {
  res.json({
    summary: compressionMetrics.getSummary(),
    recentSamples: compressionMetrics.getRecentSamples(20),
  });
}
