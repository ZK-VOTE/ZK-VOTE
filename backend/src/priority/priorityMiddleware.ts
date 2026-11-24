import type { NextFunction, Request, Response } from "express";
import {
  priorityStarvationTotal,
  priorityQueueDepth,
  priorityQueueInFlight,
} from "../services/metrics.js";
import { classifyPriority, type PriorityTier } from "./priorityConfig.js";
import { PriorityQueue, RequestTimeoutError } from "./priorityQueue.js";

export interface PriorityRequest extends Request {
  priorityTier?: PriorityTier;
}

export const globalPriorityQueue = new PriorityQueue({
  onStarvation: ({ tier, route }) => {
    priorityStarvationTotal.inc({ priority: tier, route });
  },
  onDepthChange: (snapshot) => {
    for (const { tier, queued, inFlight } of snapshot) {
      priorityQueueDepth.set({ tier }, queued);
      priorityQueueInFlight.set({ tier }, inFlight);
    }
  },
});

export function priorityMiddleware(queue: PriorityQueue = globalPriorityQueue) {
  return (req: PriorityRequest, res: Response, next: NextFunction): void => {
    const tier = classifyPriority(req.method, req.path);
    if (!tier) {
      next();
      return;
    }

    req.priorityTier = tier;
    res.setHeader("X-Priority-Tier", tier);

    const runChain = () =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          res.off("finish", finish);
          res.off("close", finish);
          res.off("error", fail);
          resolve();
        };
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          res.off("finish", finish);
          res.off("close", finish);
          res.off("error", fail);
          reject(error);
        };

        res.once("finish", finish);
        res.once("close", finish);
        res.once("error", fail);
        try {
          next();
        } catch (error) {
          fail(error as Error);
        }
      });

    void queue.enqueue(tier, runChain, req.path).catch((error) => {
      if (res.headersSent) return;
      if (error instanceof RequestTimeoutError) {
        res.status(503).json({
          error: "priority_queue_timeout",
          priority: tier,
        });
        return;
      }
      next(error);
    });
  };
}
