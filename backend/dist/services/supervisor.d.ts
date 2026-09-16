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
import { type ServiceName } from "./service-health.js";
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
export declare class ServiceSupervisor {
    private services;
    private health;
    private abortControllers;
    private restartTimers;
    private shuttingDown;
    private shutdownPromise;
    /**
     * Register a service with the supervisor
     */
    register(service: Service): void;
    /**
     * Start a specific service and all its dependencies
     */
    start(serviceName: ServiceName): Promise<void>;
    /**
     * Stop a specific service and its dependents
     */
    stop(serviceName: ServiceName): Promise<void>;
    /**
     * Mark a service run as successful (called by the service after each iteration)
     */
    markSuccess(serviceName: ServiceName): void;
    /**
     * Mark a service run as failed (called by the service on error)
     */
    markFailure(serviceName: ServiceName, error: string): void;
    /**
     * Handle service failure with exponential backoff restart
     */
    private handleServiceFailure;
    /**
     * Schedule a restart with exponential backoff
     */
    private scheduleRestart;
    /**
     * Start all registered services
     */
    startAll(): Promise<void>;
    /**
     * Stop all services in reverse dependency order (graceful shutdown)
     */
    stopAll(): Promise<void>;
    /**
     * Get health status for a specific service
     */
    getServiceHealth(serviceName: ServiceName): ServiceHealth | undefined;
    /**
     * Get health status for all services
     */
    getAllServiceHealth(): ServiceHealth[];
    /**
     * Get overall supervisor status
     */
    getStatus(): SupervisorStatus;
    /**
     * Get the abort signal for a service
     */
    getAbortSignal(serviceName: ServiceName): AbortSignal | undefined;
    /**
     * Clear all health and restart state (for testing)
     */
    reset(): void;
}
/**
 * Get or create the supervisor singleton
 */
export declare function getSupervisor(): ServiceSupervisor;
/**
 * Create a new supervisor instance (for testing)
 */
export declare function createSupervisor(): ServiceSupervisor;
//# sourceMappingURL=supervisor.d.ts.map