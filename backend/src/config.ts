/**
 * Environment Configuration
 *
 * Centralizes all environment variables and configuration.
 * Secrets can be retrieved dynamically via the SecretManager
 * for runtime fetch from Vault or Fly.io secrets.
 */

import dotenv from "dotenv";
import os from "node:os";
import fs from "fs";
import path from "path";

const nodeEnv = process.env.NODE_ENV || "development";

// Load environment variables in order of priority (highest to lowest)
// 1. Existing process.env variables (dotenv doesn't override by default)
// 2. .env.${NODE_ENV}.local
// 3. .env.${NODE_ENV}
// 4. .env.local
// 5. .env

const envFiles = [
  `.env.${nodeEnv}.local`,
  `.env.${nodeEnv}`,
  `.env.local`,
  `.env`,
];

for (const file of envFiles) {
  const envPath = path.resolve(process.cwd(), file);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

// Fallback in case none existed
dotenv.config();

// ============================================
// VALIDATION HELPERS
// ============================================

/**
 * Validate Stellar contract ID format
 */
export function isValidContractId(
  contractId: string | undefined,
): contractId is string {
  if (typeof contractId !== "string") return false;
  // Stellar contract IDs are 56-character C-addresses
  if (contractId.length !== 56) return false;
  if (!contractId.startsWith("C")) return false;
  // Base32 alphabet (uppercase)
  return /^C[A-Z2-7]{55}$/.test(contractId);
}

// ============================================
// CONFIGURATION
// ============================================

export const config = {
  // Server
  port: Number(process.env.PORT || 3001),

  // Clustering
  clusterEnabled: process.env.CLUSTER_ENABLED === "true",
  clusterWorkers: Math.max(
    1,
    Number(
      process.env.CLUSTER_WORKERS ||
        process.env.WORKER_COUNT ||
        process.env.WEB_CONCURRENCY ||
        (typeof os.availableParallelism === "function"
          ? os.availableParallelism()
          : os.cpus().length) ||
        2,
    ),
  ),

  // Soroban RPC
  rpcUrl: process.env.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc",
  rpcUrls: process.env.SOROBAN_RPC_URLS
    ? process.env.SOROBAN_RPC_URLS.split(",").map((s) => s.trim()).filter(Boolean)
    : [process.env.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc"],
  networkPassphrase:
    process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017",
  rpcTimeoutMs: Number(process.env.RPC_TIMEOUT_MS || 30_000),
  shutdownDrainTimeoutMs: Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || 30_000),

  // Authentication (read from env as fallback; see getSecret() for dynamic retrieval)
  relayerAuthToken: process.env.RELAYER_AUTH_TOKEN,
  relayerSecretKey: process.env.RELAYER_SECRET_KEY,

  // Master key for token management endpoints (REQUIRED - must be at least 32 chars)
  authMasterKey: process.env.AUTH_MASTER_KEY,

  // Token rotation configuration
  tokenRotationEnabled: process.env.TOKEN_ROTATION_ENABLED !== "false",
  tokenRotationIntervalMs: Number(
    process.env.TOKEN_ROTATION_INTERVAL_MS || 2_592_000_000,
  ),
  tokenRotationTransitionMs: Number(
    process.env.TOKEN_ROTATION_TRANSITION_MS || 172_800_000,
  ),
  defaultTokenLifetimeMs: Number(
    process.env.DEFAULT_TOKEN_LIFETIME_MS || 5_184_000_000,
  ),

  // Audit logging
  tokenAuditLogEnabled: process.env.TOKEN_AUDIT_LOG_ENABLED !== "false",

  // Contract IDs
  votingContractId: process.env.VOTING_CONTRACT_ID,
  treeContractId: process.env.TREE_CONTRACT_ID,
  commentsContractId: process.env.COMMENTS_CONTRACT_ID,
  daoRegistryContractId: process.env.DAO_REGISTRY_CONTRACT_ID,
  membershipSbtContractId: process.env.MEMBERSHIP_SBT_CONTRACT_ID,
  bridgeContractId: process.env.BRIDGE_CONTRACT_ID,
  circuitRegistryContractId: process.env.CIRCUIT_REGISTRY_CONTRACT_ID,

  // VK Version
  staticVkVersion: process.env.VOTING_VK_VERSION
    ? Number(process.env.VOTING_VK_VERSION)
    : undefined,

  // CORS
  corsOrigins: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
    : ("*" as const),

  // Logging
  logClientIp: process.env.LOG_CLIENT_IP as "plain" | "hash" | undefined,
  logRequestBody: process.env.LOG_REQUEST_BODY !== "false",
  stripRequestBodies: process.env.STRIP_REQUEST_BODIES === "true",
  genericErrors: process.env.RELAYER_GENERIC_ERRORS === "true",
  healthExposeDetails: process.env.HEALTH_EXPOSE_DETAILS !== "false",
  healthcheckPing: process.env.HEALTHCHECK_PING === "true",

  // Event Indexer
  indexerEnabled: process.env.INDEXER_ENABLED !== "false",
  indexerPollIntervalMs: Number(process.env.INDEXER_POLL_INTERVAL_MS || 5000),

  // DAO Sync
  daoSyncIntervalMs: Number(process.env.DAO_SYNC_INTERVAL_MS || 30000),

  // Membership Sync
  membershipSyncIntervalMs: Number(
    process.env.MEMBERSHIP_SYNC_INTERVAL_MS || 600000,
  ),

  // IPFS/Pinata (read from env as fallback; see getSecret() for dynamic retrieval)
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: process.env.PINATA_GATEWAY,
  ipfsEnabled: !!process.env.PINATA_JWT,
  ipfsSubdomain: process.env.IPFS_SUBDOMAIN,

  // IPFS Pin Redundancy
  /** Local directory for content backups before pinning (default: ./data/ipfs-backup) */
  ipfsBackupDir: process.env.IPFS_BACKUP_DIR || "./data/ipfs-backup",
  /** Web3.Storage API token for secondary pinning (optional) */
  web3StorageToken: process.env.WEB3_STORAGE_TOKEN,
  /** Interval between pin verification scans in ms (default: 1 hour) */
  pinVerifyIntervalMs: Number(process.env.PIN_VERIFY_INTERVAL_MS || 3_600_000),
  /** Consecutive failures before alerting (default: 3) */
  pinAlertThreshold: Number(process.env.PIN_ALERT_THRESHOLD || 3),
  /** Automatically re-pin failed content from backup (default: true) */
  pinAutoRepin: process.env.PIN_AUTO_REPIN !== "false",

  // Anti-spam: proof-of-work
  powEnabled: process.env.POW_ENABLED !== "false",
  powDifficulty: Number(process.env.POW_DIFFICULTY || 20),
  powChallengeTtlMs: Number(process.env.POW_CHALLENGE_TTL_MS || 300_000),

  // Anti-spam: per-commitment rate limiting
  commitmentRateLimit: Number(process.env.COMMITMENT_RATE_LIMIT || 5),
  commitmentRateWindowMs: Number(
    process.env.COMMITMENT_RATE_WINDOW_MS || 60_000,
  ),

  // Anti-spam: community flagging
  flagThreshold: Number(process.env.FLAG_THRESHOLD || 3),
  flagPowDifficulty: Number(process.env.FLAG_POW_DIFFICULTY || 10),

  // TTL Renewal Optimization
  ttlRenewalIntervalMs: Number(
    process.env.TTL_RENEWAL_INTERVAL_MS || 604_800_000,
  ), // 7 days
  ttlRenewalThresholdMs: Number(
    process.env.TTL_RENEWAL_THRESHOLD_MS || 1_209_600_000,
  ), // 14 days
  ttlGracePeriodMs: Number(process.env.TTL_GRACE_PERIOD_MS || 259_200_000), // 3 days
  ttlBatchSize: Number(process.env.TTL_BATCH_SIZE || 5),
  ttlCheckEnabled: process.env.TTL_CHECK_ENABLED !== "false",
  ttlCostTrackingEnabled: process.env.TTL_COST_TRACKING_ENABLED !== "false",
  ttlMaxFee: process.env.TTL_MAX_FEE || "1000000",
  ttlSlippageLedgers: Number(process.env.TTL_SLIPPAGE_LEDGERS || 8640), // ~2 days safety margin

  // Backup & Archival
  backupIntervalMs: Number(process.env.BACKUP_INTERVAL_MS || 86_400_000), // 24 hours
  s3Bucket: process.env.BACKUP_S3_BUCKET || process.env.S3_BUCKET,
  archivalAgeDays: Number(process.env.ARCHIVAL_AGE_DAYS || 90),
  archivalIntervalMs: Number(process.env.ARCHIVAL_INTERVAL_MS || 86_400_000),

  // Audit log rotation and archival
  auditLogRetentionDays: Number(
    process.env.AUDIT_LOG_RETENTION_DAYS || 90,
  ),
  auditLogRotationIntervalMs: Number(
    process.env.AUDIT_LOG_ROTATION_INTERVAL_MS || 86_400_000,
  ),
  auditLogArchiveDir:
    process.env.AUDIT_LOG_ARCHIVE_DIR || "./data/audit-archive",

  // Proof Security & Mitigations
  maxProofAgeSeconds: Number(process.env.MAX_PROOF_AGE_SECONDS || 300),
  requireClientCert: process.env.REQUIRE_CLIENT_CERT === "true",
  walletRateLimitMax: Number(process.env.WALLET_RATE_LIMIT_MAX || 5),
  walletRateLimitWindowMs: Number(process.env.WALLET_RATE_LIMIT_WINDOW_MS || 60_000),
  relayerPublicKey: process.env.RELAYER_PUBLIC_KEY || "",
  // Circuit Breakers
  circuitBreakerRpcFailureThreshold: Number(
    process.env.CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD || 5,
  ),
  circuitBreakerRpcResetMs: Number(
    process.env.CIRCUIT_BREAKER_RPC_RESET_MS || 30_000,
  ),
  circuitBreakerPinataFailureThreshold: Number(
    process.env.CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD || 5,
  ),
  circuitBreakerPinataResetMs: Number(
    process.env.CIRCUIT_BREAKER_PINATA_RESET_MS || 30_000,
  ),
  circuitBreakerGatewayFailureThreshold: Number(
    process.env.CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD || 5,
  ),
  circuitBreakerGatewayResetMs: Number(
    process.env.CIRCUIT_BREAKER_GATEWAY_RESET_MS || 30_000,
  ),

  // Memory monitoring
  memoryMonitorIntervalMs: Number(
    process.env.MEMORY_MONITOR_INTERVAL_MS || 60_000,
  ),
  // Container memory limit in MB (should match fly.toml [[vm]] memory, minus
  // a safety margin) — used to compute the usage ratio for alerting.
  memoryLimitMb: Number(process.env.MEMORY_LIMIT_MB || 512),
  memoryWarnRatio: Number(process.env.MEMORY_WARN_RATIO || 0.8),
  memoryCriticalRatio: Number(process.env.MEMORY_CRITICAL_RATIO || 0.95),
  memoryAutoRestart: process.env.MEMORY_AUTO_RESTART !== "false",

  // Cache eviction bounds
  maxCachedDaos: Number(process.env.MAX_CACHED_DAOS || 5000),
  dbQueryCacheMaxEntries: Number(process.env.DB_QUERY_CACHE_MAX_ENTRIES || 500),

  // Database / WAL Resilience
  dbBusyTimeoutMs: Number(process.env.DB_BUSY_TIMEOUT_MS || 5000),
  dbCheckpointIntervalMs: Number(process.env.DB_CHECKPOINT_INTERVAL_MS || 60000),
  dbCheckpointTransactionCount: Number(process.env.DB_CHECKPOINT_TRANSACTION_COUNT || 1000),
  dbWalWarningThresholdBytes: Number(process.env.DB_WAL_WARNING_THRESHOLD_BYTES || 100 * 1024 * 1024),
  dbBackupIntervalMs: Number(process.env.DB_BACKUP_INTERVAL_MS || 3600000),
  dbRetryCount: Number(process.env.DB_RETRY_COUNT || 5),
  dbRetryBaseDelayMs: Number(process.env.DB_RETRY_BASE_DELAY_MS || 50),
  dbRetryMaxDelayMs: Number(process.env.DB_RETRY_MAX_DELAY_MS || 2000),

  // Test mode
  testMode: process.env.RELAYER_TEST_MODE === "true",
} as const;

// ============================================
// SIZE LIMITS
// ============================================

export const LIMITS = {
  MAX_IMAGE_SIZE: 5 * 1024 * 1024, // 5MB
  MAX_METADATA_SIZE: 100 * 1024, // 100KB
  MAX_PROPOSAL_BODY: 100_000, // 100KB text
  MAX_COMMENT_BODY: 10_000, // 10KB text
  MAX_JSON_BODY: 100 * 1024, // Express body limit
  IPFS_CACHE_TTL: 15 * 60 * 1000, // 15 minutes
} as const;

// ============================================
// ALLOWED MIME TYPES
// ============================================

export const ALLOWED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/bmp",
  "image/tiff",
] as const;

// ============================================
// BN254 CONSTANTS
// ============================================

// BN254 field modulus (p)
export const BN254_MODULUS = BigInt(
  "218882428718392752222464057452572750885483644004160343698204186575808495617",
);

// BN254 scalar field modulus (r)
export const BN254_SCALAR_FIELD = BigInt(
  "0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47",
);

// ============================================
// ENVIRONMENT VALIDATION
// ============================================

/**
 * Validate required environment variables
 * Throws if required vars are missing
 */
export function validateEnv(): void {
  const missing: string[] = [];

  if (!config.votingContractId) missing.push("VOTING_CONTRACT_ID");
  if (!config.treeContractId) missing.push("TREE_CONTRACT_ID");
  if (!config.commentsContractId) missing.push("COMMENTS_CONTRACT_ID");
  if (!config.relayerSecretKey) missing.push("RELAYER_SECRET_KEY");
  if (!config.rpcUrl) missing.push("SOROBAN_RPC_URL");
  if (!config.networkPassphrase) missing.push("NETWORK_PASSPHRASE");
  if (!config.authMasterKey) missing.push("AUTH_MASTER_KEY");

  if (missing.length > 0) {
    console.error(
      JSON.stringify({ level: "error", event: "missing_env", missing }),
    );
    console.error("\nRun ./scripts/init-local.sh to generate backend/.env or configure your environment variables.");
    process.exit(1);
  }

  // Validate auth master key strength (minimum 32 characters for security)
  // Prevent production secrets in non-production environments
  const isProd = process.env.NODE_ENV === "production";
  if (
    !isProd &&
    config.relayerSecretKey &&
    config.relayerSecretKey.startsWith("S") &&
    config.relayerSecretKey.length === 56 &&
    !config.testMode && 
    config.relayerSecretKey !== "SCZANGBA5AKIA7VTJQXBDKPQOBFZD3NWKNR3CQULPSFMJUADSHWFUCS" // allow the specific test key
  ) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "production_secret_in_non_prod",
      }),
    );
    console.warn("WARNING: A valid Stellar Secret Key is being used in a non-production environment. Please use placeholders (e.g. S_PLACEHOLDER...) for non-production profiles unless you explicitly need a real key.");
  }

  // Validate auth token strength (minimum 32 characters for security)
  // Skip validation in test mode since tests set short tokens for convenience
  if (
    config.authMasterKey &&
    config.authMasterKey.length < 32 &&
    !config.testMode
  ) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "weak_auth_master_key",
        length: config.authMasterKey.length,
        minLength: 32,
      }),
    );
    console.error("AUTH_MASTER_KEY must be at least 32 characters");
    process.exit(1);
  }

  // Validate legacy RELAYER_AUTH_TOKEN if provided (backward compatibility)
  if (
    config.relayerAuthToken &&
    config.relayerAuthToken.length < 32 &&
    !config.testMode
  ) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "weak_legacy_auth_token",
        length: config.relayerAuthToken.length,
        minLength: 32,
      }),
    );
    console.error("RELAYER_AUTH_TOKEN must be at least 32 characters");
    process.exit(1);
  }

  // Validate contract IDs
  if (!isValidContractId(config.votingContractId)) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "invalid_contract_id",
        var: "VOTING_CONTRACT_ID",
        value: config.votingContractId,
      }),
    );
    process.exit(1);
  }

  if (!isValidContractId(config.treeContractId)) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "invalid_contract_id",
        var: "TREE_CONTRACT_ID",
        value: config.treeContractId,
      }),
    );
    process.exit(1);
  }

  if (!isValidContractId(config.commentsContractId)) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "invalid_contract_id",
        var: "COMMENTS_CONTRACT_ID",
        value: config.commentsContractId,
      }),
    );
    process.exit(1);
  }
}