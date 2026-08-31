/**
 * Circuit Breaker
 *
 * Generic circuit breaker for external service dependencies (Soroban RPC,
 * Pinata, public IPFS gateways). Prevents cascading failures by failing
 * fast once a dependency is known to be degraded, instead of letting every
 * caller run its own retry/timeout logic against a service that is down.
 *
 * States:
 *  - closed:    requests pass through; failures are counted in a rolling window
 *  - open:      requests fail immediately without calling the service
 *  - half_open: a limited number of test requests are allowed through to
 *               probe recovery; success closes the circuit, failure reopens it
 */
export type CircuitState = "closed" | "open" | "half_open";
export interface CircuitBreakerOptions {
    /** Consecutive/rolling-window failures before the circuit opens */
    failureThreshold: number;
    /** How long the circuit stays open before allowing a probe request */
    resetTimeoutMs: number;
    /** Rolling window over which failures are counted (ms) */
    failureWindowMs?: number;
}
export interface CircuitBreakerMetrics {
    name: string;
    state: CircuitState;
    failureCount: number;
    tripCount: number;
    lastFailureAt: string | null;
    lastStateChangeAt: string;
    openedTotalMs: number;
}
export declare class CircuitBreakerOpenError extends Error {
    constructor(name: string);
}
export declare class CircuitBreaker {
    private readonly name;
    private readonly options;
    private state;
    private failureTimestamps;
    private tripCount;
    private lastFailureAt;
    private lastStateChangeAt;
    private openedAt;
    private openedTotalMs;
    private halfOpenInFlight;
    constructor(name: string, options: CircuitBreakerOptions);
    getState(): CircuitState;
    getMetrics(): CircuitBreakerMetrics;
    /**
     * Run fn through the breaker. Throws CircuitBreakerOpenError immediately
     * without calling fn if the circuit is open.
     */
    execute<T>(fn: () => Promise<T>): Promise<T>;
    private onSuccess;
    private onFailure;
    private maybeTransitionToHalfOpen;
    private transitionTo;
}
export declare function registerCircuitBreaker(name: string, options: CircuitBreakerOptions): CircuitBreaker;
export declare function getAllCircuitBreakerMetrics(): CircuitBreakerMetrics[];
//# sourceMappingURL=circuit-breaker.d.ts.map