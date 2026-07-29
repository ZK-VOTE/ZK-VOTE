/**
 * Graceful Degradation Middleware (#204)
 *
 * Request-scoped bag of degraded services. On response, sets:
 *   X-Service-Degraded: ipfs,comments
 *   X-Service-Status: ipfs=degraded;comments=degraded
 */

import { AsyncLocalStorage } from "async_hooks";
import type { Request, Response, NextFunction } from "express";
import { getDegradedServiceNames } from "../services/service-health.js";

interface DegradationStore {
  noted: Set<string>;
}

const als = new AsyncLocalStorage<DegradationStore>();

export function degradationContext(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const store: DegradationStore = { noted: new Set() };
  als.run(store, () => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      applyDegradationHeaders(res);
      return originalJson(body);
    }) as Response["json"];

    const originalSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      applyDegradationHeaders(res);
      return originalSend(body);
    }) as Response["send"];

    next();
  });
}

function applyDegradationHeaders(res: Response): void {
  if (res.headersSent) return;
  const store = als.getStore();
  const fromRequest = store ? Array.from(store.noted) : [];
  const fromRegistry = getDegradedServiceNames();
  const all = Array.from(new Set([...fromRequest, ...fromRegistry]));
  if (all.length === 0) return;

  res.setHeader("X-Service-Degraded", all.join(","));
  res.setHeader(
    "X-Service-Status",
    all.map((s) => `${s}=degraded`).join(";"),
  );
}

/** Mark a service as degraded for this request (and optionally globally). */
export function noteDegraded(service: string): void {
  const store = als.getStore();
  if (store) store.noted.add(service);
}

/**
 * Send a partial success response with degradation indicators.
 */
export function sendPartial(
  res: Response,
  body: Record<string, unknown>,
  services: string[],
  statusCode = 200,
): void {
  for (const s of services) noteDegraded(s);
  res.status(statusCode).json({
    ...body,
    degraded: true,
    degradedServices: services,
  });
}
