/**
 * Secret Rotation Monitor
 *
 * Tracks secret rotation status and expiration.
 * Checks whether secrets are overdue for rotation based on
 * configured rotation intervals and expiration dates.
 */
import { createLogger } from "../logger.js";
const logger = createLogger("rotation-monitor");
/**
 * Default rotation intervals per secret type (in milliseconds)
 */
export const DEFAULT_ROTATION_INTERVALS = {
    RELAYER_SECRET_KEY: 30 * 24 * 60 * 60 * 1000, // 30 days
    RELAYER_AUTH_TOKEN: 7 * 24 * 60 * 60 * 1000, // 7 days
    PINATA_JWT: 30 * 24 * 60 * 60 * 1000, // 30 days
};
/**
 * Calculate rotation status for a single secret
 */
export function checkRotationStatus(key, metadata) {
    const interval = metadata?.rotationIntervalMs ??
        DEFAULT_ROTATION_INTERVALS[key] ??
        30 * 24 * 60 * 60 * 1000;
    const lastRotated = metadata?.lastRotatedAt
        ? new Date(metadata.lastRotatedAt).getTime()
        : null;
    const expiresAt = metadata?.expiresAt
        ? new Date(metadata.expiresAt).getTime()
        : null;
    const now = Date.now();
    let nextRotationAt = null;
    let isOverdue = false;
    let status = "healthy";
    if (lastRotated !== null) {
        nextRotationAt = new Date(lastRotated + interval).toISOString();
        isOverdue = now > lastRotated + interval;
    }
    if (expiresAt !== null && now > expiresAt) {
        status = "overdue";
        isOverdue = true;
    }
    else if (isOverdue) {
        status = "overdue";
    }
    else if (expiresAt !== null && now > expiresAt - 7 * 24 * 60 * 60 * 1000) {
        status = "expiring-soon";
    }
    else if (lastRotated !== null &&
        now > lastRotated + interval - 7 * 24 * 60 * 60 * 1000) {
        status = "expiring-soon";
    }
    else if (lastRotated === null) {
        status = "unknown";
    }
    return {
        key,
        lastRotatedAt: lastRotated ? new Date(lastRotated).toISOString() : null,
        nextRotationAt,
        isOverdue,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        status,
    };
}
/**
 * Check rotation status for all tracked secrets
 */
export function checkAllRotations(secrets) {
    const results = [];
    for (const [key, entry] of Object.entries(secrets)) {
        results.push(checkRotationStatus(key, entry.metadata));
    }
    return results;
}
/**
 * Get overall health based on rotation statuses
 */
export function getOverallHealth(rotationStatuses) {
    if (rotationStatuses.some((s) => s.status === "overdue")) {
        return "critical";
    }
    if (rotationStatuses.some((s) => s.status === "expiring-soon" || s.status === "unknown")) {
        return "degraded";
    }
    return "healthy";
}
/**
 * Log rotation check results
 */
export function logRotationStatus(statuses) {
    for (const status of statuses) {
        if (status.status !== "healthy") {
            logger.warn("rotation_status", {
                key: status.key,
                status: status.status,
                lastRotatedAt: status.lastRotatedAt,
                nextRotationAt: status.nextRotationAt,
            });
        }
    }
}
//# sourceMappingURL=rotation-monitor.js.map