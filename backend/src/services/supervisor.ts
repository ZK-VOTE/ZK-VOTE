/**
 * Service Supervisor with Crash Recovery (#176)
 *
 * Manages background services (indexer, DAO sync, membership sync, TTL renewal)
 * with automatic restart using exponential backoff, health tracking, and
 * dependency-aware shutdown ordering.
 *
 * Key features:
 * - Automatic restart with exponential backoff for crashed services
 * - Per-service health checks (last successful run time, error count)
 * - Service dependency tracking
 * - Graceful shutdown ordering
 * - Alert when a service fails repeatedly (>3 consecutive failures)
 * - Service lifecycle event logging
 */

import { log } from "./logger.js";
import {
  markDegraded,
  markHealthy,
  markUnavailable,
  type ServiceName,
} from "./service-health.js";

// ============================================
// TYPES
// ============================================

/** Service function that can be started and stopped */
export interface Service {
  /** Unique service identifier */
  name: ServiceName;
  /** Start the service. Throws on failure. */
  start(): Promise<void> | void;
  /** Stop the service gracefully */
  stop(): Promise<void> | void;
  /** Service dependencies (must be running before this service starts) */
  dependencies?: ServiceName[];
  /** Whether this service is enabled */
  enabled?: boolean;
}

/** Health status for a single service */
export interface ServiceHealth {
  name: ServiceName;
  state: "running" | "stopped" | "failed" | "restarting";
  startedAt: string | null;
  lastSuccessfulRun: string | null;
  consecutiveFailures: number;
  totalFailures: number;
  totalRestarts: number;
  lastError: string | null;
  dependencies: ServiceName[];
}

/** Overall supervisor status */
export interface SupervisorStatus {
  services: ServiceHealth[];
  uptime: number;
  isShuttingDown: boolean;
}

// ============================================
// CONSTANTS
// ============================================

/** Maximum consecutive failures before alerting */
const MAX_FAILURES_BEFORE_ALERT = 3;

/** Base delay for exponential backoff (ms) */
const BASE_BACKOFF_MS = 1_000;

/** Maximum backoff delay (ms) */
const MAX_BACKOFF_MS = 60_000;

/** Backoff multiplier */
const BACKOFF_MULTIPLIER = 2;

// ============================================
// SERVICE SUPERVISOR CLASS
// ============================================

export class ServiceSupervisor {
  private services = new Map<ServiceName, Service>();
  private health = new Map<ServiceName, ServiceHealth>();
  private abortControllers = new Map<ServiceName, AbortController>();
  private restartTimers = new Map<ServiceName, NodeJS.Timeout>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  /**
   * Register a service with the supervisor
   */
  register(service: Service): void {
    if (this.services.has(service.name)) {
      log("warn", "supervisor_service_already_registered", {
        service: service.name,
      });
      return;
    }

    this.services.set(service.name, service);
    this.health.set(service.name, {
      name: service.name,
      state: "stopped",
      startedAt: null,
      lastSuccessfulRun: null,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalRestarts: 0,
      lastError: null,
      dependencies: service.dependencies ?? [],
    });

    log("info", "supervisor_service_registered", { service: service.name });
  }

  /**
   * Start a specific service and all its dependencies
   */
  async start(serviceName: ServiceName): Promise<void> {
    if (this.shuttingDown) {
      log("warn", "supervisor_start_during_shutdown", { service: serviceName });
      return;
    }

    const service = this.services.get(serviceName);
    if (!service) {
      log("error", "supervisor_service_not_found", { service: serviceName });
      return;
    }

    // Check if service is enabled
    if (service.enabled === false) {
      log("info", "supervisor_service_disabled", { service: serviceName });
      return;
    }

    // Check if already running
    const health = this.health.get(serviceName);
    if (health?.state === "running") {
      log("warn", "supervisor_already_running", { service: serviceName });
      return;
    }

    // Start dependencies first
    const deps = service.dependencies ?? [];
    for (const dep of deps) {
      const depHealth = this.health.get(dep);
      if (depHealth?.state !== "running") {
        await this.start(dep);
      }
    }

    // Start the service
    try {
      const controller = new AbortController();
      this.abortControllers.set(serviceName, controller);

      await Promise.resolve(service.start());

      this.health.set(serviceName, {
        ...health!,
        state: "running",
        startedAt: new Date().toISOString(),
        consecutiveFailures: 0,
        lastError: null,
      });

      markHealthy(serviceName);
      log("info", "supervisor_service_started", { service: serviceName });
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.handleServiceFailure(serviceName, errorMsg);
    }
  }

  /**
   * Stop a specific service and its dependents
   */
  async stop(serviceName: ServiceName): Promise<void> {
    const service = this.services.get(serviceName);
    if (!service) return;

    // Cancel any pending restart
    const restartTimer = this.restartTimers.get(serviceName);
    if (restartTimer) {
      clearTimeout(restartTimer);
      this.restartTimers.delete(serviceName);
    }

    // Abort any in-progress operations
    const controller = this.abortControllers.get(serviceName);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(serviceName);
    }

    // Find and stop all services that depend on this one
    const dependents: ServiceName[] = [];
    for (const [name, svc] of this.services) {
      if (svc.dependencies?.includes(serviceName)) {
        dependents.push(name);
      }
    }

    for (const dep of dependents) {
      await this.stop(dep);
    }

    // Stop the service itself
    try {
      await Promise.resolve(service.stop());

      this.health.set(serviceName, {
        ...this.health.get(serviceName)!,
        state: "stopped",
      });

      log("info", "supervisor_service_stopped", { service: serviceName });
    } catch (error) {
      log("error", "supervisor_service_stop_error", {
        service: serviceName,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Mark a service run as successful (called by the service after each iteration)
   */
  markSuccess(serviceName: ServiceName): void {
    const health = this.health.get(serviceName);
    if (health) {
      this.health.set(serviceName, {
        ...health,
        lastSuccessfulRun: new Date().toISOString(),
        consecutiveFailures: 0,
      });
      markHealthy(serviceName);
    }
  }

  /**
   * Mark a service run as failed (called by the service on error)
   */
  markFailure(serviceName: ServiceName, error: string): void {
    this.handleServiceFailure(serviceName, error);
  }

  /**
   * Handle service failure with exponential backoff restart
   */
  private handleServiceFailure(serviceName: ServiceName, error: string): void {
    const health = this.health.get(serviceName);
    if (!health) return;

    const consecutiveFailures = health.consecutiveFailures + 1;
    const totalFailures = health.totalFailures + 1;

    this.health.set(serviceName, {
      ...health,
      state: "failed",
      consecutiveFailures,
      totalFailures,
      lastError: error,
    });

    markDegraded(serviceName, error);

    // Log the failure
    log("error", "supervisor_service_failed", {
      service: serviceName,
      consecutiveFailures,
      totalFailures,
      error,
    });

    // Alert on repeated failures
    if (consecutiveFailures >= MAX_FAILURES_BEFORE_ALERT) {
      log("error", "supervisor_repeated_failure_alert", {
        service: serviceName,
        consecutiveFailures,
        totalFailures,
        message: `Service ${serviceName} has failed ${consecutiveFailures} times consecutively`,
      });
    }

    // Schedule restart with exponential backoff (unless shutting down)
    if (!this.shuttingDown) {
      this.scheduleRestart(serviceName, consecutiveFailures);
    }
  }

  /**
   * Schedule a restart with exponential backoff
   */
  private scheduleRestart(
    serviceName: ServiceName,
    attempt: number,
  ): void {
    // Clear existing restart timer for this service
    const existingTimer = this.restartTimers.get(serviceName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Calculate backoff delay with jitter
    const baseDelay = Math.min(
      BASE_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1),
      MAX_BACKOFF_MS,
    );
    // Add 10-20% jitter to prevent thundering herd
    const jitter = baseDelay * (0.1 + Math.random() * 0.1);
    const delay = Math.floor(baseDelay + jitter);

    log("info", "supervisor_restart_scheduled", {
      service: serviceName,
      attempt,
      delayMs: delay,
    });

    const timer = setTimeout(async () => {
      this.restartTimers.delete(serviceName);
      const health = this.health.get(serviceName);
      if (health) {
        this.health.set(serviceName, {
          ...health,
          state: "restarting",
        });
      }

      log("info", "supervisor_service_restarting", {
        service: serviceName,
        attempt,
      });

      await this.start(serviceName);
    }, delay);

    // Keep timer from keeping process alive
    timer.unref();
    this.restartTimers.set(serviceName, timer);
  }

  /**
   * Start all registered services
   */
  async startAll(): Promise<void> {
    log("info", "supervisor_starting_all", {
      serviceCount: this.services.size,
    });

    // Start services in dependency order
    const started = new Set<ServiceName>();
    const starting = new Set<ServiceName>();

    const startService = async (name: ServiceName): Promise<void> => {
      if (started.has(name) || starting.has(name)) return;

      const service = this.services.get(name);
      if (!service) return;

      starting.add(name);

      // Start dependencies first
      const deps = service.dependencies ?? [];
      for (const dep of deps) {
        await startService(dep);
      }

      await this.start(name);
      started.add(name);
      starting.delete(name);
    };

    for (const name of this.services.keys()) {
      await startService(name);
    }

    log("info", "supervisor_all_services_started", {
      serviceCount: started.size,
    });
  }

  /**
   * Stop all services in reverse dependency order (graceful shutdown)
   */
  async stopAll(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Cancel all restart timers
    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();

    log("info", "supervisor_stopping_all", {
      serviceCount: this.services.size,
    });

    // Stop services in reverse dependency order
    const stopped = new Set<ServiceName>();
    const stopping = new Set<ServiceName>();

    const stopService = async (name: ServiceName): Promise<void> => {
      if (stopped.has(name) || stopping.has(name)) return;

      stopping.add(name);

      // Stop dependents first
      for (const [svcName, svc] of this.services) {
        if (svc.dependencies?.includes(name)) {
          await stopService(svcName);
        }
      }

      await this.stop(name);
      stopped.add(name);
      stopping.delete(name);
    };

    for (const name of this.services.keys()) {
      await stopService(name);
    }

    log("info", "supervisor_all_services_stopped", {
      serviceCount: stopped.size,
    });
  }

  /**
   * Get health status for a specific service
   */
  getServiceHealth(serviceName: ServiceName): ServiceHealth | undefined {
    return this.health.get(serviceName);
  }

  /**
   * Get health status for all services
   */
  getAllServiceHealth(): ServiceHealth[] {
    return Array.from(this.health.values());
  }

  /**
   * Get overall supervisor status
   */
  getStatus(): SupervisorStatus {
    return {
      services: this.getAllServiceHealth(),
      uptime: process.uptime(),
      isShuttingDown: this.shuttingDown,
    };
  }

  /**
   * Get the abort signal for a service
   */
  getAbortSignal(serviceName: ServiceName): AbortSignal | undefined {
    return this.abortControllers.get(serviceName)?.signal;
  }

  /**
   * Clear all health and restart state (for testing)
   */
  reset(): void {
    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
    this.abortControllers.clear();

    for (const [name] of this.health) {
      this.health.set(name, {
        ...this.health.get(name)!,
        state: "stopped",
        consecutiveFailures: 0,
        totalFailures: 0,
        totalRestarts: 0,
        lastError: null,
      });
    }
    this.shuttingDown = false;
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

let supervisor: ServiceSupervisor | null = null;

/**
 * Get or create the supervisor singleton
 */
export function getSupervisor(): ServiceSupervisor {
  if (!supervisor) {
    supervisor = new ServiceSupervisor();
  }
  return supervisor;
}

/**
 * Create a new supervisor instance (for testing)
 */
export function createSupervisor(): ServiceSupervisor {
  return new ServiceSupervisor();
}
