/**
 * Structured Logger Service
 *
 * Provides structured JSON logging with sensitive field redaction.
 */
import crypto from "crypto";
// ============================================
// REDACTION
// ============================================
const REDACTED_FIELDS = [
    "proof",
    "nullifier",
    "commitment",
    "secret",
    "token",
    "password",
    "jwt",
];
function redact(obj) {
    const safe = { ...obj };
    for (const key of REDACTED_FIELDS) {
        if (key in safe) {
            safe[key] = "[REDACTED]";
        }
    }
    return safe;
}
/**
 * Create a logger instance for a specific service
 */
export function createLogger(service) {
    const log = (level, event, meta = {}) => {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            service,
            event,
            ...redact(meta),
        };
        console.log(JSON.stringify(entry));
    };
    return {
        log,
        debug: (event, meta) => log("debug", event, meta),
        info: (event, meta) => log("info", event, meta),
        warn: (event, meta) => log("warn", event, meta),
        error: (event, meta) => log("error", event, meta),
    };
}
/**
 * Generate a unique request ID
 */
export function generateRequestId() {
    return crypto.randomBytes(6).toString("hex");
}
/**
 * Hash an IP address for privacy
 */
export function hashIp(ip) {
    return crypto
        .createHash("sha256")
        .update(ip || "")
        .digest("hex")
        .slice(0, 12);
}
// ============================================
// SIMPLE LOG FUNCTION
// ============================================
/**
 * Simple log function compatible with existing code
 */
export function log(level, event, meta = {}) {
    const safe = redact(meta);
    console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...safe }));
}
// Default logger instance
export const logger = createLogger("relayer");
//# sourceMappingURL=logger.js.map