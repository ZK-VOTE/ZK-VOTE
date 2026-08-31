/**
 * Secrets Management Type Definitions
 */
export interface VaultConfig {
    url: string;
    token?: string;
    roleId?: string;
    secretId?: string;
    mountPath?: string;
}
export interface SecretMetadata {
    key: string;
    version?: number;
    createdAt?: string;
    expiresAt?: string;
    lastRotatedAt?: string;
    rotationIntervalMs?: number;
}
export interface SecretEntry {
    value: string;
    metadata: SecretMetadata;
}
export interface AuditEntry {
    timestamp: string;
    secretKey: string;
    operation: "get" | "rotate" | "set" | "delete";
    success: boolean;
    requestId?: string;
    source?: string;
    error?: string;
}
export interface RotationStatus {
    key: string;
    lastRotatedAt: string | null;
    nextRotationAt: string | null;
    isOverdue: boolean;
    expiresAt: string | null;
    status: "healthy" | "expiring-soon" | "overdue" | "unknown";
}
export interface SecretHealth {
    overall: "healthy" | "degraded" | "critical";
    secrets: RotationStatus[];
    vaultAvailable?: boolean;
    lastCheckedAt: string;
}
export type SecretBackend = "vault" | "fly-secrets" | "env";
export interface SecretManagerOptions {
    vault?: VaultConfig;
    fallbackToEnv?: boolean;
    encryptionKey?: string;
    rotationCheckIntervalMs?: number;
}
//# sourceMappingURL=types.d.ts.map