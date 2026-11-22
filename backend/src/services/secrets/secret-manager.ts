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

import type {
  VaultConfig,
  SecretBackend,
  SecretManagerOptions,
} from "./types.js";
import { encrypt, isEncrypted, generateMasterKey } from "./encryptor.js";
import { auditLog, createAuditEntry } from "./audit-logger.js";
import {
  checkRotationStatus,
  getOverallHealth,
  DEFAULT_ROTATION_INTERVALS,
} from "./rotation-monitor.js";
import { log } from "../logger.js";
import crypto from "node:crypto";

// ============================================
// MODULE STATE
// ============================================

let vaultConfig: VaultConfig | undefined;
let encryptionKey: string;
let backend: SecretBackend = "env";
const rotationMetadata: Record<
  string,
  { metadata: import("./types.js").SecretMetadata | undefined }
> = {};

// Track in-flight fetches to avoid duplicate requests
const pendingFetches: Map<string, Promise<string | undefined>> = new Map();

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the secrets manager with configuration options.
 * Must be called before any secret is retrieved.
 */
export function initSecretManager(options: SecretManagerOptions): void {
  if (options.vault) {
    vaultConfig = options.vault;
    backend = "vault";
  } else {
    vaultConfig = undefined;
    backend = options.fallbackToEnv !== false ? "fly-secrets" : "env";
  }

  encryptionKey = options.encryptionKey ?? generateMasterKey();

  log("info", "secret_manager_initialized", {
    backend,
    vaultConfigured: !!vaultConfig,
    encryptionEnabled: true,
  });
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Boot-time readiness check (#919). In production, refuses to start when Vault
 * is configured but unreachable, so the process never runs against a silently
 * downgraded secret source. No-op when Vault is not configured.
 */
export async function assertSecretBackendReady(
  timeoutMs = 5_000,
): Promise<void> {
  if (!vaultConfig?.url) return;
  try {
    const response = await fetch(`${vaultConfig.url}/v1/sys/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok && response.status !== 429 && response.status !== 472 && response.status !== 473) {
      throw new Error(`Vault health returned ${response.status}`);
    }
  } catch (err) {
    const message = (err as Error).message;
    log("error", "vault_unavailable_at_boot", { error: message });
    if (isProduction()) {
      throw new Error(`Refusing to start: Vault is configured but unavailable (${message})`);
    }
  }
}

/**
 * Get the current backend in use
 */
export function getSecretBackend(): SecretBackend {
  return backend;
}

// ============================================
// VAULT INTEGRATION
// ============================================

/**
 * Fetch a secret from HashiCorp Vault via its HTTP API.
 * Uses the token-based authentication method.
 * Returns null if Vault is unavailable or the secret is not found.
 */
async function fetchFromVault(key: string): Promise<string | null> {
  if (!vaultConfig?.url) return null;

  try {
    const url = `${vaultConfig.url}/v1/secret/data/${key}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (vaultConfig.token) {
      headers["X-Vault-Token"] = vaultConfig.token;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        log("warn", "vault_secret_not_found", { key });
        return null;
      }
      throw new Error(`Vault API returned ${response.status}`);
    }

    const body = await response.json();
    const secretValue = body?.data?.data?.[key];

    if (typeof secretValue !== "string") {
      log("warn", "vault_secret_invalid_format", { key });
      return null;
    }

    return secretValue;
  } catch (err) {
    log("error", "vault_fetch_failed", { key, error: (err as Error).message });
    return null;
  }
}

/**
 * Store a secret in Vault (used for rotation)
 * Returns true if the write succeeded
 */
async function storeInVault(key: string, value: string): Promise<boolean> {
  if (!vaultConfig?.url) return false;

  try {
    const url = `${vaultConfig.url}/v1/secret/data/${key}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (vaultConfig.token) {
      headers["X-Vault-Token"] = vaultConfig.token;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: { [key]: value },
        options: { cas: 0 },
      }),
    });

    return response.ok;
  } catch (err) {
    log("error", "vault_store_failed", { key, error: (err as Error).message });
    return false;
  }
}

// ============================================
// SECRET RETRIEVAL
// ============================================

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
export async function getSecret(
  key: string,
  options?: { requestId?: string; source?: string },
): Promise<string | undefined> {
  const requestId = options?.requestId ?? cryptoRandomId();

  // Check if we already have a pending fetch for this key
  const pending = pendingFetches.get(key);
  if (pending) {
    try {
      const value = await pending;
      auditLog(createAuditEntry(key, "get", true, requestId, options?.source));
      return value;
    } catch {
      // Falling through to retry below
    }
  }

  const fetchPromise = fetchSecretValue(key);
  pendingFetches.set(key, fetchPromise);

  try {
    const value = await fetchPromise;
    pendingFetches.delete(key);
    // Audit records the outcome; the value itself is never logged.
    auditLog(
      createAuditEntry(
        key,
        "get",
        value !== undefined,
        requestId,
        options?.source,
        value === undefined ? "not_found_or_fail_closed" : undefined,
      ),
    );
    return value;
  } catch (err) {
    pendingFetches.delete(key);
    auditLog(
      createAuditEntry(
        key,
        "get",
        false,
        requestId,
        options?.source,
        (err as Error).message,
      ),
    );
    return undefined;
  } finally {
    // Clean up pending entry if it wasn't the same promise
    if (pendingFetches.get(key) === fetchPromise) {
      pendingFetches.delete(key);
    }
  }
}

/**
 * Internal: fetch a secret value from the configured backend
 */
async function fetchSecretValue(key: string): Promise<string | undefined> {
  // Try Vault first
  if (vaultConfig) {
    const vaultValue = await fetchFromVault(key);
    if (vaultValue !== null) {
      return vaultValue;
    }
    // Fail closed in production: a Vault miss must never downgrade the secret
    // source to env vars (#919).
    if (isProduction()) {
      log("error", "vault_fail_closed", { key });
      return undefined;
    }
    log("warn", "vault_fallback_to_env", { key });
  }

  // Fallback to environment variables (Fly.io secrets or .env)
  const envValue = process.env[key];
  if (envValue) {
    backend =
      key.startsWith("FLY_SECRET_") || key.includes("FLY")
        ? "fly-secrets"
        : "env";
    return envValue;
  }

  return undefined;
}

// ============================================
// SET / ROTATE SECRETS
// ============================================

/**
 * Set a secret value. Stores to Vault if configured, otherwise updates env var.
 * The value is encrypted at rest before storage.
 */
export async function setSecret(
  key: string,
  value: string,
  options?: {
    metadata?: import("./types.js").SecretMetadata;
    requestId?: string;
  },
): Promise<boolean> {
  // Encrypt the value at rest
  const storedValue = encrypt(value, encryptionKey);

  if (vaultConfig) {
    const success = await storeInVault(key, storedValue);
    auditLog(
      createAuditEntry(
        key,
        "set",
        success,
        options?.requestId,
        "vault",
        success ? undefined : "store_failed",
      ),
    );

    // Store metadata for rotation tracking
    if (success && options?.metadata) {
      rotationMetadata[key] = { metadata: options.metadata };
    }

    return success;
  }

  // Fallback: store in env (this is a process-level env var, not persistent)
  process.env[key] = storedValue;
  auditLog(createAuditEntry(key, "set", true, options?.requestId, "env"));

  if (options?.metadata) {
    rotationMetadata[key] = { metadata: options.metadata };
  }

  return true;
}

// ============================================
// ROTATION MONITORING
// ============================================

/**
 * Check the rotation status of all tracked secrets
 */
export async function checkRotationHealth(): Promise<
  import("./types.js").SecretHealth
> {
  const statuses: import("./types.js").RotationStatus[] = [];

  for (const [key, entry] of Object.entries(rotationMetadata)) {
    statuses.push(checkRotationStatus(key, entry.metadata));
  }

  // Also check env vars that haven't been explicitly tracked
  const trackedKeys = new Set(Object.keys(rotationMetadata));
  const secretKeys = ["RELAYER_SECRET_KEY", "RELAYER_AUTH_TOKEN", "PINATA_JWT"];

  for (const key of secretKeys) {
    if (!trackedKeys.has(key)) {
      const value = process.env[key];
      if (value) {
        const meta = isEncrypted(value)
          ? { key, rotationIntervalMs: DEFAULT_ROTATION_INTERVALS[key] }
          : undefined;
        if (meta) {
          rotationMetadata[key] = { metadata: meta };
        }
        statuses.push(checkRotationStatus(key, meta));
      }
    }
  }

  const overall = getOverallHealth(statuses);

  log("info", "rotation_check_complete", {
    overall,
    checked: statuses.length,
    overdue: statuses.filter((s) => s.isOverdue).length,
  });

  return {
    overall,
    secrets: statuses,
    vaultAvailable: !!vaultConfig,
    lastCheckedAt: new Date().toISOString(),
  };
}

// ============================================
// HELPERS
// ============================================

function cryptoRandomId(): string {
  return crypto.randomBytes(6).toString("hex");
}
