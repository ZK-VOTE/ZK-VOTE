/**
 * Secret Rotation Monitor
 *
 * Tracks secret rotation status and expiration.
 * Checks whether secrets are overdue for rotation based on
 * configured rotation intervals and expiration dates.
 */
import type { RotationStatus, SecretMetadata } from "./types.js";
/**
 * Default rotation intervals per secret type (in milliseconds)
 */
export declare const DEFAULT_ROTATION_INTERVALS: Record<string, number>;
/**
 * Calculate rotation status for a single secret
 */
export declare function checkRotationStatus(key: string, metadata: SecretMetadata | undefined): RotationStatus;
/**
 * Check rotation status for all tracked secrets
 */
export declare function checkAllRotations(secrets: Record<string, {
    metadata: SecretMetadata | undefined;
}>): RotationStatus[];
/**
 * Get overall health based on rotation statuses
 */
export declare function getOverallHealth(rotationStatuses: RotationStatus[]): "healthy" | "degraded" | "critical";
/**
 * Log rotation check results
 */
export declare function logRotationStatus(statuses: RotationStatus[]): void;
//# sourceMappingURL=rotation-monitor.d.ts.map