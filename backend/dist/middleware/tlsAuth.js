/**
 * TLS Client Certificate Authentication Middleware
 *
 * Enforces TLS client certificate (mTLS) authentication for proof submission routes
 * when config.requireClientCert (or REQUIRE_CLIENT_CERT=true) is enabled.
 *
 * Only trust the Node TLS socket — never attacker-controlled HTTP headers such as
 * X-Client-Cert / X-Forwarded-Client-Cert / Ssl-Client-Verify.
 */
import { config } from "../config.js";
function isAuthorizedTlsSocket(socket) {
    if (!socket || typeof socket !== "object") {
        return false;
    }
    const tlsSocket = socket;
    // Must be a real TLS connection that completed client-cert auth.
    if (!tlsSocket.encrypted || tlsSocket.authorized !== true) {
        return false;
    }
    // Prefer a non-empty peer certificate when the API is available.
    if (typeof tlsSocket.getPeerCertificate === "function") {
        try {
            const cert = tlsSocket.getPeerCertificate(true);
            if (!cert || Object.keys(cert).length === 0) {
                return false;
            }
        }
        catch {
            return false;
        }
    }
    return true;
}
/**
 * Middleware verifying that incoming request has a valid client TLS certificate
 * presented on the TLS socket (not via spoofable proxy headers).
 */
export function tlsClientCertGuard(req, res, next) {
    if (!config.requireClientCert) {
        return next();
    }
    // Express may expose the TLS socket on req.socket or (behind some proxies)
    // req.client — never fall back to request headers.
    const socketAuthorized = isAuthorizedTlsSocket(req.socket) ||
        isAuthorizedTlsSocket(req.client);
    if (!socketAuthorized) {
        return res.status(401).json({
            error: "TLS client certificate required for proof submission",
        });
    }
    next();
}
//# sourceMappingURL=tlsAuth.js.map