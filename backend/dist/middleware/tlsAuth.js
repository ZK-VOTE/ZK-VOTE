/**
 * TLS Client Certificate Authentication Middleware
 *
 * Enforces TLS client certificate (mTLS) authentication for proof submission routes
 * when config.requireClientCert (or REQUIRE_CLIENT_CERT=true) is enabled.
 */
import { config } from "../config.js";
/**
 * Middleware verifying that incoming request has a valid client TLS certificate.
 */
export function tlsClientCertGuard(req, res, next) {
    if (!config.requireClientCert) {
        return next();
    }
    // Check socket TLS certificate authorization status or proxy header
    const clientAuthSocket = req.socket?.authorized || req.client?.authorized;
    const headerCert = req.headers["x-client-cert-present"] === "true" ||
        req.headers["ssl-client-verify"] === "SUCCESS";
    if (!clientAuthSocket && !headerCert) {
        return res.status(401).json({
            error: "TLS client certificate required for proof submission",
        });
    }
    next();
}
//# sourceMappingURL=tlsAuth.js.map