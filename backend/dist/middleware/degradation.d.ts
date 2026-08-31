/**
 * Graceful Degradation Middleware (#204)
 *
 * Request-scoped bag of degraded services. On response, sets:
 *   X-Service-Degraded: ipfs,comments
 *   X-Service-Status: ipfs=degraded;comments=degraded
 */
import type { Request, Response, NextFunction } from "express";
export declare function degradationContext(_req: Request, res: Response, next: NextFunction): void;
/** Mark a service as degraded for this request (and optionally globally). */
export declare function noteDegraded(service: string): void;
/**
 * Send a partial success response with degradation indicators.
 */
export declare function sendPartial(res: Response, body: Record<string, unknown>, services: string[], statusCode?: number): void;
//# sourceMappingURL=degradation.d.ts.map