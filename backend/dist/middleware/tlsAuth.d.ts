/**
 * TLS Client Certificate Authentication Middleware
 *
 * Enforces TLS client certificate (mTLS) authentication for proof submission routes
 * when config.requireClientCert (or REQUIRE_CLIENT_CERT=true) is enabled.
 */
import type { Request, Response, NextFunction } from "express";
/**
 * Middleware verifying that incoming request has a valid client TLS certificate.
 */
export declare function tlsClientCertGuard(req: Request, res: Response, next: NextFunction): void | Response<any, Record<string, any>>;
//# sourceMappingURL=tlsAuth.d.ts.map