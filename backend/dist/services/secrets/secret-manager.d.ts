/**
 * Secrets Manager
 *
 * Central secret retrieval service that supports multiple backends:
 * 1. HashiCorp Vault (primary, via API)
 * 2. Fly.io secrets (env vars, fallback)
 * 3. Direct environment variables (last resort)
 *
 * Every secret access is audited and logged.
 * Secrets are fetched dynamically at runtime, not cached at startup.
 */
import type { SecretBackend, SecretManagerOptions } from "./types.js";
/**
 * Initialize the secrets manager with configuration options.
 * Must be called before any secret is retrieved.
 */
export declare function initSecretManager(options: SecretManagerOptions): void;
/**
 * Get the current backend in use
 */
export declare function getSecretBackend(): SecretBackend;
/**
 * Retrieve a secret value dynamically at runtime.
 *
 * Priority order:
 * 1. Vault (if configured) - fetches live from Vault API
 * 2. Fly.io secrets (env vars set via `fly secrets`)
 * 3. Direct environment variables
 *
 * Every access is audited and logged.
 * In-flight duplicate requests are coalesced to avoid redundant fetches.
 */
export declare function getSecret(key: string, options?: {
    requestId?: string;
    source?: string;
}): Promise<string | undefined>;
/**
 * Set a secret value. Stores to Vault if configured, otherwise updates env var.
 * The value is encrypted at rest before storage.
 */
export declare function setSecret(key: string, value: string, options?: {
    metadata?: import("./types.js").SecretMetadata;
    requestId?: string;
}): Promise<boolean>;
/**
 * Check the rotation status of all tracked secrets
 */
export declare function checkRotationHealth(): Promise<import("./types.js").SecretHealth>;
//# sourceMappingURL=secret-manager.d.ts.map