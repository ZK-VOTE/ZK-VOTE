/**
 * TLS Client Certificate Authentication Middleware
 *
 * Enforces TLS client certificate (mTLS) authentication for proof submission routes
 * when config.requireClientCert (or REQUIRE_CLIENT_CERT=true) is enabled.
 *
 * Only trust the Node TLS socket — never attacker-controlled HTTP headers such as
 * X-Client-Cert / X-Forwarded-Client-Cert / Ssl-Client-Verify.
 */
import type { Request, Response, NextFunction } from "express";
/**
 * Middleware verifying that incoming request has a valid client TLS certificate
 * presented on the TLS socket (not via spoofable proxy headers).
 */
export declare function tlsClientCertGuard(req: Request, res: Response, next: NextFunction): void | Response<any, Record<string, any>>;
//# sourceMappingURL=tlsAuth.d.ts.map