/**
 * Auth Token Scheduler Service
 *
 * Handles periodic background tasks:
 * - Automatic token rotation on configurable schedule
 * - Expiration of timed-out tokens
 * - Cleanup of revoked/expired tokens
 * - Audit log cleanup
 */

import { config } from "../config.js";
import { createLogger } from "./logger.js";
import {
  runMaintenanceTasks,
  migrateLegacyToken,
} from "./authTokens.js";

const logger = createLogger("auth-scheduler");

let maintenanceInterval: NodeJS.Timeout | null = null;
let legacyMigrated = false;

const MAINTENANCE_INTERVAL_MS = Math.min(
  config.tokenRotationIntervalMs,
  6 * 60 * 60 * 1000,
);

export function ensureLegacyTokenMigrated(): void {
  if (legacyMigrated) return;
  try {
    migrateLegacyToken();
    legacyMigrated = true;
    logger.info("legacy_token_migration_checked");
  } catch (err) {
    logger.error("legacy_token_migration_error", {
      error: (err as Error).message,
    });
  }
}

function runScheduledMaintenance(): void {
  try {
    ensureLegacyTokenMigrated();

    const result = runMaintenanceTasks();

    if (
      result.expiredCount > 0 ||
      result.cleanedTokens > 0 ||
      result.cleanedAuditEntries > 0 ||
      result.rotatedCount > 0
    ) {
      logger.info("auth_maintenance_completed", result);
    } else {
      logger.debug("auth_maintenance_no_changes");
    }
  } catch (err) {
    logger.error("auth_maintenance_failed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
}

export function startAuthScheduler(): void {
  if (maintenanceInterval) {
    logger.warn("auth_scheduler_already_running");
    return;
  }

  ensureLegacyTokenMigrated();

  if (!config.tokenRotationEnabled) {
    logger.info("auth_scheduler_rotation_disabled");
  }

  maintenanceInterval = setInterval(
    runScheduledMaintenance,
    MAINTENANCE_INTERVAL_MS,
  );

  logger.info("auth_scheduler_started", {
    intervalMs: MAINTENANCE_INTERVAL_MS,
    rotationEnabled: config.tokenRotationEnabled,
    rotationIntervalMs: config.tokenRotationIntervalMs,
    transitionPeriodMs: config.tokenRotationTransitionMs,
    defaultLifetimeMs: config.defaultTokenLifetimeMs,
  });
}

export function stopAuthScheduler(): void {
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
    logger.info("auth_scheduler_stopped");
  }
}

export function isAuthSchedulerRunning(): boolean {
  return maintenanceInterval !== null;
}
