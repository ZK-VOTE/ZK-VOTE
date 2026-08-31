/**
 * Structured Logger Service with PII Redaction
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogMeta = Record<string, any>;
export interface RedactionPolicy {
    redactedFields: string[];
    detailedLevels: LogLevel[];
    showClientIp: "plain" | "hash" | "none";
    showBodyKeysOnly: boolean;
    stellarTruncateLength: number;
}
export declare function setRedactionPolicy(policy: Partial<RedactionPolicy>): void;
export declare function getRedactionPolicy(): RedactionPolicy;
export declare function truncateStellarAddress(address: string): string;
export declare function redact(meta: LogMeta, level?: LogLevel): LogMeta;
export interface Logger {
    log(level: LogLevel, event: string, meta?: LogMeta): void;
    debug(event: string, meta?: LogMeta): void;
    info(event: string, meta?: LogMeta): void;
    warn(event: string, meta?: LogMeta): void;
    error(event: string, meta?: LogMeta): void;
}
export declare function createLogger(service: string): Logger;
export declare function generateRequestId(): string;
export declare function hashIp(ip: string | undefined): string;
export declare function log(level: LogLevel, event: string, meta?: LogMeta): void;
export declare const logger: Logger;
//# sourceMappingURL=logger.d.ts.map