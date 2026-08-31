/**
 * Structured Logger Service with PII Redaction
 */
import crypto from "crypto";
const DEFAULT_POLICY = {
    redactedFields: [
        "proof",
        "nullifier",
        "commitment",
        "secret",
        "token",
        "password",
        "jwt",
        "refresh_token",
        "access_token",
        "api_key",
        "private_key",
        "seed",
        "mnemonic",
    ],
    detailedLevels: ["debug"],
    showClientIp: "hash",
    showBodyKeysOnly: true,
    stellarTruncateLength: 4,
};
let currentPolicy = { ...DEFAULT_POLICY };
export function setRedactionPolicy(policy) {
    currentPolicy = { ...currentPolicy, ...policy };
}
export function getRedactionPolicy() {
    return { ...currentPolicy };
}
export function truncateStellarAddress(address) {
    if (!address || address.length < 8)
        return "[REDACTED]";
    const prefix = currentPolicy.stellarTruncateLength;
    return address.slice(0, prefix) + "..." + address.slice(-prefix);
}
function applyRedaction(value, key, level) {
    if (value && typeof value === "object" && value !== null) {
        if (Array.isArray(value)) {
            return value.map((v) => applyRedaction(v, key, level));
        }
        const result = {};
        for (const [k, v] of Object.entries(value)) {
            result[k] = applyRedaction(v, k, level);
        }
        return result;
    }
    // Check if this field is in the redacted fields list
    if (currentPolicy.redactedFields.some((f) => key.toLowerCase().includes(f.toLowerCase()) ||
        f.toLowerCase().includes(key.toLowerCase()))) {
        return "[REDACTED]";
    }
    // For string values, apply pattern-based redaction
    if (typeof value === "string") {
        // Stellar addresses
        if (value.match(/^G[A-Z0-9]{55}$/)) {
            return truncateStellarAddress(value);
        }
        // Stellar secret keys
        if (value.match(/^S[A-Z0-9]{55}$/)) {
            return "[REDACTED_SECRET]";
        }
        // IP addresses
        if (value.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)) {
            return "[REDACTED_IP]";
        }
        // Transaction hashes (64 hex)
        if (value.match(/^[0-9a-fA-F]{64}$/)) {
            return value.slice(0, 6) + "..." + value.slice(-6);
        }
        // IPFS CIDs
        if (value.match(/^(Qm|bafy)[a-zA-Z0-9]{44,59}$/)) {
            return value.slice(0, 6) + "..." + value.slice(-6);
        }
        return value;
    }
    return value;
}
export function redact(meta, level = "info") {
    const isDetailed = currentPolicy.detailedLevels.includes(level);
    const safe = {};
    for (const [key, value] of Object.entries(meta)) {
        if (isDetailed &&
            !currentPolicy.redactedFields.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
            safe[key] = value;
            continue;
        }
        safe[key] = applyRedaction(value, key, level);
    }
    return safe;
}
export function createLogger(service) {
    const log = (level, event, meta = {}) => {
        const minLevel = (process.env.LOG_LEVEL || "info");
        const levels = ["debug", "info", "warn", "error"];
        if (levels.indexOf(level) < levels.indexOf(minLevel)) {
            return;
        }
        const redactedMeta = redact(meta, level);
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            service,
            event,
            env: process.env.NODE_ENV || "development",
            ...redactedMeta,
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
export function generateRequestId() {
    return crypto.randomBytes(6).toString("hex");
}
export function hashIp(ip) {
    return crypto
        .createHash("sha256")
        .update(ip || "")
        .digest("hex")
        .slice(0, 12);
}
export function log(level, event, meta = {}) {
    const safe = redact(meta, level);
    const minLevel = (process.env.LOG_LEVEL || "info");
    const levels = ["debug", "info", "warn", "error"];
    if (levels.indexOf(level) < levels.indexOf(minLevel)) {
        return;
    }
    console.log(JSON.stringify({
        level,
        event,
        ts: new Date().toISOString(),
        env: process.env.NODE_ENV || "development",
        ...safe,
    }));
}
export const logger = createLogger(process.env.SERVICE_NAME || "relayer");
//# sourceMappingURL=logger.js.map