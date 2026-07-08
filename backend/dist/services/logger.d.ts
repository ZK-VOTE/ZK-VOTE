/**
 * Structured Logger Service
 *
 * Provides structured JSON logging with sensitive field redaction.
 */
import type { LogLevel, LogMeta } from "../types/index.js";
export interface Logger {
    log(level: LogLevel, event: string, meta?: LogMeta): void;
    debug(event: string, meta?: LogMeta): void;
    info(event: string, meta?: LogMeta): void;
    warn(event: string, meta?: LogMeta): void;
    error(event: string, meta?: LogMeta): void;
}
/**
 * Create a logger instance for a specific service
 */
export declare function createLogger(service: string): Logger;
/**
 * Generate a unique request ID
 */
export declare function generateRequestId(): string;
/**
 * Hash an IP address for privacy
 */
export declare function hashIp(ip: string | undefined): string;
/**
 * Simple log function compatible with existing code
 */
export declare function log(level: LogLevel, event: string, meta?: LogMeta): void;
export declare const logger: Logger;
//# sourceMappingURL=logger.d.ts.map