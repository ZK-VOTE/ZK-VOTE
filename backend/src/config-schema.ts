/**
 * Configuration Schema (Zod)
 *
 * Single source of truth for all environment variables.
 * Provides type-safe access, validation, documentation, and .env.example generation.
 *
 * Every config variable must be declared here. The schema is the authoritative
 * reference — if a variable is used in code but not in this schema, it is a gap.
 */

import { z } from "zod";

// ============================================
// HELPERS
// ============================================

/** Optional string that defaults to undefined when empty */
const optionalString = z.string().optional();

/** Comma-separated list that splits into an array */
const commaSeparatedArray = z
  .string()
  .optional()
  .transform((val) =>
    val
      ? val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

/** Boolean env var: "true" = true, anything else = false. Defaults given via .default() */
const envBool = (defaultVal: boolean = false) =>
  z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined) return defaultVal;
      return val === "true" || val === "1";
    });

/** Numeric env var with default */
const envInt = (defaultVal: number) =>
  z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined) return defaultVal;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? defaultVal : parsed;
    });

/** Float env var with default */
const envFloat = (defaultVal: number) =>
  z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined) return defaultVal;
      const parsed = parseFloat(val);
      return isNaN(parsed) ? defaultVal : parsed;
    });

/** Stellar C-address format */
const stellarContractId = z
  .string()
  .regex(
    /^C[A-Z2-7]{55}$/,
    "Must be a 56-character Stellar contract ID (C + 55 base32 chars)",
  );

// ============================================
// CONFIGURATION SCHEMA
// ============================================

export const configSchema = z
  .object({
    // ── Server ──────────────────────────────────────────────────
    PORT: envInt(3001)
      .describe("HTTP server port for the relayer"),

    // ── Soroban RPC ─────────────────────────────────────────────
    SOROBAN_RPC_URL: z
      .string()
      .url("Must be a valid URL")
      .default("http://localhost:8000/soroban/rpc")
      .describe("Primary Soroban RPC endpoint URL"),

    SOROBAN_RPC_URLS: commaSeparatedArray
      .describe(
        "Comma-separated list of RPC URLs for load balancing. Falls back to SOROBAN_RPC_URL",
      ),

    NETWORK_PASSPHRASE: z
      .string()
      .default("Standalone Network ; February 2017")
      .describe("Stellar network passphrase (Standalone/Testnet/Public)"),

    RPC_TIMEOUT_MS: envInt(30_000)
      .describe("Timeout in ms for RPC calls"),

    // ── Authentication ──────────────────────────────────────────
    RELAYER_AUTH_TOKEN: z
      .string()
      .min(32, "Auth token must be at least 32 characters for security")
      .describe("Shared secret token for write endpoints (vote, comment, sync)"),

    RELAYER_SECRET_KEY: optionalString
      .describe("Stellar secret key for the relayer account (kept in Vault/Fly secrets)"),

    // ── Contract IDs ────────────────────────────────────────────
    VOTING_CONTRACT_ID: stellarContractId.describe(
      "Stellar contract ID for the Voting contract",
    ),
    TREE_CONTRACT_ID: stellarContractId.describe(
      "Stellar contract ID for the MembershipTree contract",
    ),
    COMMENTS_CONTRACT_ID: stellarContractId.describe(
      "Stellar contract ID for the Comments contract",
    ),
    DAO_REGISTRY_CONTRACT_ID: stellarContractId.optional().describe(
      "Stellar contract ID for the DaoRegistry contract",
    ),
    MEMBERSHIP_SBT_CONTRACT_ID: stellarContractId.optional().describe(
      "Stellar contract ID for the MembershipSBT contract",
    ),
    BRIDGE_CONTRACT_ID: stellarContractId.optional().describe(
      "Stellar contract ID for the Bridge contract",
    ),
    CIRCUIT_REGISTRY_CONTRACT_ID: stellarContractId.optional().describe(
      "Stellar contract ID for the CircuitRegistry contract",
    ),

    // ── VK Version ──────────────────────────────────────────────
    VOTING_VK_VERSION: envInt(0)
      .describe("Static verification key version override (0 = auto-detect)"),

    // ── CORS ────────────────────────────────────────────────────
    CORS_ORIGIN: optionalString
      .describe(
        "Comma-separated allowed origins for CORS. Default: * (all origins)",
      ),

    // ── Logging ─────────────────────────────────────────────────
    LOG_CLIENT_IP: z
      .enum(["plain", "hash"])
      .optional()
      .describe("IP logging mode: 'plain' = raw IP, 'hash' = SHA-256 truncated, omit = skip"),

    LOG_REQUEST_BODY: envBool(true)
      .describe("Log request body keys on start (not values)"),

    STRIP_REQUEST_BODIES: envBool(false)
      .describe("Reject requests with a body (test mode safety)"),

    RELAYER_GENERIC_ERRORS: envBool(false)
      .describe("Suppress error details and body logging in responses"),

    HEALTH_EXPOSE_DETAILS: envBool(true)
      .describe("Expose detailed health info (requires auth)"),

    HEALTHCHECK_PING: envBool(false)
      .describe("Ping RPC on /health (adds latency)"),

    // ── Event Indexer ───────────────────────────────────────────
    INDEXER_ENABLED: envBool(true)
      .describe("Enable Soroban event indexer polling"),

    INDEXER_POLL_INTERVAL_MS: envInt(5000)
      .describe("Polling interval for event indexer in ms"),

    // ── DAO Sync ────────────────────────────────────────────────
    DAO_SYNC_INTERVAL_MS: envInt(30_000)
      .describe("Interval for syncing DAO metadata in ms"),

    // ── Membership Sync ─────────────────────────────────────────
    MEMBERSHIP_SYNC_INTERVAL_MS: envInt(600_000)
      .describe("Interval for syncing membership state in ms"),

    // ── IPFS / Pinata ───────────────────────────────────────────
    PINATA_JWT: optionalString.describe("Pinata API JWT for IPFS pinning"),

    PINATA_GATEWAY: optionalString.describe(
      "Custom Pinata gateway URL (default: gateway.pinata.cloud)",
    ),

    // ── IPFS Pin Redundancy ─────────────────────────────────────
    IPFS_BACKUP_DIR: z
      .string()
      .default("./data/ipfs-backup")
      .describe("Local directory for content backups before pinning"),

    WEB3_STORAGE_TOKEN: optionalString.describe(
      "Web3.Storage API token for secondary pinning",
    ),

    PIN_VERIFY_INTERVAL_MS: envInt(3_600_000)
      .describe("Interval between pin verification scans in ms (default: 1 hour)"),

    PIN_ALERT_THRESHOLD: envInt(3)
      .describe("Consecutive failures before alerting"),

    PIN_AUTO_REPIN: envBool(true)
      .describe("Automatically re-pin failed content from local backup"),

    // ── Anti-Spam: Proof of Work ────────────────────────────────
    POW_ENABLED: envBool(true)
      .describe("Enable proof-of-work anti-spam"),

    POW_DIFFICULTY: envInt(20)
      .describe("PoW difficulty (higher = harder)"),

    POW_CHALLENGE_TTL_MS: envInt(300_000)
      .describe("PoW challenge TTL in ms (default: 5 minutes)"),

    // ── Anti-Spam: Rate Limiting ────────────────────────────────
    COMMITMENT_RATE_LIMIT: envInt(5)
      .describe("Max commitments per window"),

    COMMITMENT_RATE_WINDOW_MS: envInt(60_000)
      .describe("Rate limit window in ms"),

    // ── Anti-Spam: Community Flagging ───────────────────────────
    FLAG_THRESHOLD: envInt(3)
      .describe("Flags needed to trigger community flag"),

    FLAG_POW_DIFFICULTY: envInt(10)
      .describe("PoW difficulty for flag operations"),

    // ── TTL Renewal Optimization ─────────────────────────────────
    TTL_RENEWAL_INTERVAL_MS: envInt(604_800_000)
      .describe("TTL renewal check interval in ms (default: 7 days)"),

    TTL_RENEWAL_THRESHOLD_MS: envInt(1_209_600_000)
      .describe("Renew TTL when remaining time is below this (default: 14 days)"),

    TTL_GRACE_PERIOD_MS: envInt(259_200_000)
      .describe("Grace period for TTL renewal in ms (default: 3 days)"),

    TTL_BATCH_SIZE: envInt(5)
      .describe("Max renewals per batch"),

    TTL_CHECK_ENABLED: envBool(true)
      .describe("Enable periodic TTL checks"),

    TTL_COST_TRACKING_ENABLED: envBool(true)
      .describe("Track TTL renewal costs"),

    TTL_MAX_FEE: z
      .string()
      .default("1000000")
      .describe("Maximum fee for TTL renewal transactions"),

    TTL_SLIPPAGE_LEDGERS: envInt(8640)
      .describe("Ledger slippage safety margin (~2 days)"),

    // ── Backup & Archival ───────────────────────────────────────
    BACKUP_INTERVAL_MS: envInt(86_400_000)
      .describe("Backup interval in ms (default: 24 hours)"),

    BACKUP_S3_BUCKET: optionalString.describe("S3 bucket for backups"),
    S3_BUCKET: optionalString.describe("S3 bucket (alias for BACKUP_S3_BUCKET)"),

    ARCHIVAL_AGE_DAYS: envInt(90)
      .describe("Days before event archival"),

    ARCHIVAL_INTERVAL_MS: envInt(86_400_000)
      .describe("Archival check interval in ms"),

    // ── Circuit Breakers ────────────────────────────────────────
    CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD: envInt(5)
      .describe("RPC failures before circuit opens"),

    CIRCUIT_BREAKER_RPC_RESET_MS: envInt(30_000)
      .describe("RPC circuit reset interval in ms"),

    CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD: envInt(5)
      .describe("Pinata failures before circuit opens"),

    CIRCUIT_BREAKER_PINATA_RESET_MS: envInt(30_000)
      .describe("Pinata circuit reset interval in ms"),

    CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD: envInt(5)
      .describe("Gateway failures before circuit opens"),

    CIRCUIT_BREAKER_GATEWAY_RESET_MS: envInt(30_000)
      .describe("Gateway circuit reset interval in ms"),

    // ── Memory Monitoring ───────────────────────────────────────
    MEMORY_MONITOR_INTERVAL_MS: envInt(60_000)
      .describe("Memory monitoring interval in ms"),

    MEMORY_LIMIT_MB: envInt(512)
      .describe("Container memory limit in MB (should match fly.toml)"),

    MEMORY_WARN_RATIO: envFloat(0.8)
      .describe("Memory usage ratio for warning alerts"),

    MEMORY_CRITICAL_RATIO: envFloat(0.95)
      .describe("Memory usage ratio for critical alerts"),

    MEMORY_AUTO_RESTART: envBool(true)
      .describe("Auto-restart on critical memory usage"),

    // ── Cache ───────────────────────────────────────────────────
    MAX_CACHED_DAOS: envInt(5000)
      .describe("Max DAOs cached in memory"),

    DB_QUERY_CACHE_MAX_ENTRIES: envInt(500)
      .describe("Max DB query cache entries"),

    // ── Test Mode ───────────────────────────────────────────────
    RELAYER_TEST_MODE: envBool(false)
      .describe("Enable test mode (relaxes validation, bypasses crypto)"),

    // ── Logging Sampling (NEW) ──────────────────────────────────
    LOG_SAMPLING_RATE: envFloat(0.1)
      .describe("Default sampling rate for successful requests (0.0-1.0)"),

    LOG_SAMPLING_ERROR_RATE: envFloat(1.0)
      .describe("Sampling rate for error responses (4xx/5xx, always 1.0 recommended)"),

    LOG_SAMPLING_SLOW_RATE: envFloat(1.0)
      .describe("Sampling rate for slow requests (>1s, always 1.0 recommended)"),

    LOG_SLOW_THRESHOLD_MS: envInt(1000)
      .describe("Response time threshold in ms to classify as slow"),

    LOG_BODY_MAX_CHARS: envInt(2000)
      .describe("Max characters to log from request/response bodies"),

    // ── Hot-Reload Settings (NEW) ───────────────────────────────
    HOT_RELOAD_ENABLED: envBool(false)
      .describe("Enable config hot-reload for non-critical settings"),
  })
  .passthrough(); // Allow extra env vars not in schema (e.g. NODE_ENV)

export type RawConfig = z.infer<typeof configSchema>;

// ============================================
// VALIDATED CONFIGURATION
// ============================================

/**
 * Parse and validate environment variables against the schema.
 * Returns the validated config object and any warnings.
 */
export function validateConfig(
  env: Record<string, string | undefined> = process.env,
): {
  config: ValidatedConfig;
  warnings: string[];
} {
  const warnings: string[] = [];

  const result = configSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.errors;
    const required = errors.filter((e) => e.code === "invalid_type" && e.received === "undefined");
    const invalid = errors.filter((e) => e.code !== "invalid_type" || e.received !== "undefined");

    if (required.length > 0) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "missing_required_config",
          missing: required.map((e) => ({
            variable: e.path.join("."),
            message: e.message,
          })),
        }),
      );
    }

    if (invalid.length > 0) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "invalid_config",
          errors: invalid.map((e) => ({
            variable: e.path.join("."),
            message: e.message,
          })),
        }),
      );
    }

    console.error("\nRun 'npm run config:generate' to create a .env file");
    process.exit(1);
  }

  const raw = result.data;

  // Build validated config object with snake_case → camelCase mapping
  const config: ValidatedConfig = {
    // Server
    port: raw.PORT,

    // Soroban RPC
    rpcUrl: raw.SOROBAN_RPC_URL,
    rpcUrls: raw.SOROBAN_RPC_URLS ?? [raw.SOROBAN_RPC_URL],
    networkPassphrase: raw.NETWORK_PASSPHRASE,
    rpcTimeoutMs: raw.RPC_TIMEOUT_MS,

    // Auth
    relayerAuthToken: raw.RELAYER_AUTH_TOKEN,
    relayerSecretKey: raw.RELAYER_SECRET_KEY,

    // Contract IDs
    votingContractId: raw.VOTING_CONTRACT_ID,
    treeContractId: raw.TREE_CONTRACT_ID,
    commentsContractId: raw.COMMENTS_CONTRACT_ID,
    daoRegistryContractId: raw.DAO_REGISTRY_CONTRACT_ID,
    membershipSbtContractId: raw.MEMBERSHIP_SBT_CONTRACT_ID,
    bridgeContractId: raw.BRIDGE_CONTRACT_ID,
    circuitRegistryContractId: raw.CIRCUIT_REGISTRY_CONTRACT_ID,

    // VK Version
    staticVkVersion: raw.VOTING_VK_VERSION || undefined,

    // CORS
    corsOrigins: raw.CORS_ORIGIN
      ? raw.CORS_ORIGIN.split(",").map((o) => o.trim())
      : ("*" as const),

    // Logging
    logClientIp: raw.LOG_CLIENT_IP,
    logRequestBody: raw.LOG_REQUEST_BODY,
    stripRequestBodies: raw.STRIP_REQUEST_BODIES,
    genericErrors: raw.RELAYER_GENERIC_ERRORS,
    healthExposeDetails: raw.HEALTH_EXPOSE_DETAILS,
    healthcheckPing: raw.HEALTHCHECK_PING,

    // Event Indexer
    indexerEnabled: raw.INDEXER_ENABLED,
    indexerPollIntervalMs: raw.INDEXER_POLL_INTERVAL_MS,

    // DAO Sync
    daoSyncIntervalMs: raw.DAO_SYNC_INTERVAL_MS,

    // Membership Sync
    membershipSyncIntervalMs: raw.MEMBERSHIP_SYNC_INTERVAL_MS,

    // IPFS
    pinataJwt: raw.PINATA_JWT,
    pinataGateway: raw.PINATA_GATEWAY,
    ipfsEnabled: !!raw.PINATA_JWT,

    // IPFS Pin Redundancy
    ipfsBackupDir: raw.IPFS_BACKUP_DIR,
    web3StorageToken: raw.WEB3_STORAGE_TOKEN,
    pinVerifyIntervalMs: raw.PIN_VERIFY_INTERVAL_MS,
    pinAlertThreshold: raw.PIN_ALERT_THRESHOLD,
    pinAutoRepin: raw.PIN_AUTO_REPIN,

    // Anti-Spam
    powEnabled: raw.POW_ENABLED,
    powDifficulty: raw.POW_DIFFICULTY,
    powChallengeTtlMs: raw.POW_CHALLENGE_TTL_MS,
    commitmentRateLimit: raw.COMMITMENT_RATE_LIMIT,
    commitmentRateWindowMs: raw.COMMITMENT_RATE_WINDOW_MS,
    flagThreshold: raw.FLAG_THRESHOLD,
    flagPowDifficulty: raw.FLAG_POW_DIFFICULTY,

    // TTL Renewal
    ttlRenewalIntervalMs: raw.TTL_RENEWAL_INTERVAL_MS,
    ttlRenewalThresholdMs: raw.TTL_RENEWAL_THRESHOLD_MS,
    ttlGracePeriodMs: raw.TTL_GRACE_PERIOD_MS,
    ttlBatchSize: raw.TTL_BATCH_SIZE,
    ttlCheckEnabled: raw.TTL_CHECK_ENABLED,
    ttlCostTrackingEnabled: raw.TTL_COST_TRACKING_ENABLED,
    ttlMaxFee: raw.TTL_MAX_FEE,
    ttlSlippageLedgers: raw.TTL_SLIPPAGE_LEDGERS,

    // Backup & Archival
    backupIntervalMs: raw.BACKUP_INTERVAL_MS,
    s3Bucket: raw.BACKUP_S3_BUCKET || raw.S3_BUCKET,
    archivalAgeDays: raw.ARCHIVAL_AGE_DAYS,
    archivalIntervalMs: raw.ARCHIVAL_INTERVAL_MS,

    // Circuit Breakers
    circuitBreakerRpcFailureThreshold: raw.CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD,
    circuitBreakerRpcResetMs: raw.CIRCUIT_BREAKER_RPC_RESET_MS,
    circuitBreakerPinataFailureThreshold: raw.CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD,
    circuitBreakerPinataResetMs: raw.CIRCUIT_BREAKER_PINATA_RESET_MS,
    circuitBreakerGatewayFailureThreshold: raw.CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD,
    circuitBreakerGatewayResetMs: raw.CIRCUIT_BREAKER_GATEWAY_RESET_MS,

    // Memory Monitoring
    memoryMonitorIntervalMs: raw.MEMORY_MONITOR_INTERVAL_MS,
    memoryLimitMb: raw.MEMORY_LIMIT_MB,
    memoryWarnRatio: raw.MEMORY_WARN_RATIO,
    memoryCriticalRatio: raw.MEMORY_CRITICAL_RATIO,
    memoryAutoRestart: raw.MEMORY_AUTO_RESTART,

    // Cache
    maxCachedDaos: raw.MAX_CACHED_DAOS,
    dbQueryCacheMaxEntries: raw.DB_QUERY_CACHE_MAX_ENTRIES,

    // Test Mode
    testMode: raw.RELAYER_TEST_MODE,

    // Logging Sampling
    logSamplingRate: raw.LOG_SAMPLING_RATE,
    logSamplingErrorRate: raw.LOG_SAMPLING_ERROR_RATE,
    logSamplingSlowRate: raw.LOG_SAMPLING_SLOW_RATE,
    logSlowThresholdMs: raw.LOG_SLOW_THRESHOLD_MS,
    logBodyMaxChars: raw.LOG_BODY_MAX_CHARS,

    // Hot-Reload
    hotReloadEnabled: raw.HOT_RELOAD_ENABLED,
  };

  // Test mode warnings
  if (config.testMode) {
    warnings.push("Test mode enabled — relayer auth and crypto checks are relaxed");
  }

  // Check for missing optional but recommended vars
  if (!config.daoRegistryContractId) {
    warnings.push("DAO_REGISTRY_CONTRACT_ID not set — DAO sync features unavailable");
  }
  if (!config.pinataJwt) {
    warnings.push("PINATA_JWT not set — IPFS features unavailable");
  }

  return { config, warnings };
}

// ============================================
// TYPE-SAFE CONFIG OBJECT
// ============================================

export interface ValidatedConfig {
  // Server
  port: number;

  // Soroban RPC
  rpcUrl: string;
  rpcUrls: string[];
  networkPassphrase: string;
  rpcTimeoutMs: number;

  // Auth
  relayerAuthToken: string;
  relayerSecretKey: string | undefined;

  // Contract IDs
  votingContractId: string;
  treeContractId: string;
  commentsContractId: string;
  daoRegistryContractId: string | undefined;
  membershipSbtContractId: string | undefined;
  bridgeContractId: string | undefined;
  circuitRegistryContractId: string | undefined;

  // VK Version
  staticVkVersion: number | undefined;

  // CORS
  corsOrigins: readonly string[] | "*";

  // Logging
  logClientIp: "plain" | "hash" | undefined;
  logRequestBody: boolean;
  stripRequestBodies: boolean;
  genericErrors: boolean;
  healthExposeDetails: boolean;
  healthcheckPing: boolean;

  // Event Indexer
  indexerEnabled: boolean;
  indexerPollIntervalMs: number;

  // DAO Sync
  daoSyncIntervalMs: number;

  // Membership Sync
  membershipSyncIntervalMs: number;

  // IPFS
  pinataJwt: string | undefined;
  pinataGateway: string | undefined;
  ipfsEnabled: boolean;

  // IPFS Pin Redundancy
  ipfsBackupDir: string;
  web3StorageToken: string | undefined;
  pinVerifyIntervalMs: number;
  pinAlertThreshold: number;
  pinAutoRepin: boolean;

  // Anti-Spam
  powEnabled: boolean;
  powDifficulty: number;
  powChallengeTtlMs: number;
  commitmentRateLimit: number;
  commitmentRateWindowMs: number;
  flagThreshold: number;
  flagPowDifficulty: number;

  // TTL Renewal
  ttlRenewalIntervalMs: number;
  ttlRenewalThresholdMs: number;
  ttlGracePeriodMs: number;
  ttlBatchSize: number;
  ttlCheckEnabled: boolean;
  ttlCostTrackingEnabled: boolean;
  ttlMaxFee: string;
  ttlSlippageLedgers: number;

  // Backup & Archival
  backupIntervalMs: number;
  s3Bucket: string | undefined;
  archivalAgeDays: number;
  archivalIntervalMs: number;

  // Circuit Breakers
  circuitBreakerRpcFailureThreshold: number;
  circuitBreakerRpcResetMs: number;
  circuitBreakerPinataFailureThreshold: number;
  circuitBreakerPinataResetMs: number;
  circuitBreakerGatewayFailureThreshold: number;
  circuitBreakerGatewayResetMs: number;

  // Memory Monitoring
  memoryMonitorIntervalMs: number;
  memoryLimitMb: number;
  memoryWarnRatio: number;
  memoryCriticalRatio: number;
  memoryAutoRestart: boolean;

  // Cache
  maxCachedDaos: number;
  dbQueryCacheMaxEntries: number;

  // Test Mode
  testMode: boolean;

  // Logging Sampling
  logSamplingRate: number;
  logSamplingErrorRate: number;
  logSamplingSlowRate: number;
  logSlowThresholdMs: number;
  logBodyMaxChars: number;

  // Hot-Reload
  hotReloadEnabled: boolean;
}

// ============================================
// .env.example GENERATION
// ============================================

/**
 * Generate a .env.example file from the Zod schema.
 * Called via: npm run config:generate
 */
export function generateEnvExample(): string {
  const lines: string[] = [
    "# ============================================",
    "# ZKVote Relayer — Auto-generated .env.example",
    "# Generated from config-schema.ts",
    "# DO NOT EDIT MANUALLY — regenerate with: npm run config:generate",
    "# ============================================",
    "",
  ];

  // Group variables by category
  const categories: Record<string, Array<{ key: string; description: string; default: string; required: boolean }>> = {
    "Server": [
      { key: "PORT", description: "HTTP server port", default: "3001", required: false },
    ],
    "Soroban RPC": [
      { key: "SOROBAN_RPC_URL", description: "Primary Soroban RPC endpoint", default: "http://localhost:8000/soroban/rpc", required: false },
      { key: "SOROBAN_RPC_URLS", description: "Comma-separated RPC URLs for load balancing", default: "(empty — uses SOROBAN_RPC_URL)", required: false },
      { key: "NETWORK_PASSPHRASE", description: "Stellar network passphrase", default: "Standalone Network ; February 2017", required: false },
      { key: "RPC_TIMEOUT_MS", description: "RPC call timeout in ms", default: "30000", required: false },
    ],
    "Authentication (REQUIRED)": [
      { key: "RELAYER_AUTH_TOKEN", description: "Shared secret for write endpoints (min 32 chars)", default: "REPLACE_ME_WITH_SECURE_TOKEN_MIN_32_CHARS", required: true },
      { key: "RELAYER_SECRET_KEY", description: "Stellar relayer secret key (from Vault/Fly secrets)", default: "(from secrets backend)", required: false },
    ],
    "Contract IDs (REQUIRED)": [
      { key: "VOTING_CONTRACT_ID", description: "Voting contract address", default: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", required: true },
      { key: "TREE_CONTRACT_ID", description: "MembershipTree contract address", default: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", required: true },
      { key: "COMMENTS_CONTRACT_ID", description: "Comments contract address", default: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", required: true },
      { key: "DAO_REGISTRY_CONTRACT_ID", description: "DaoRegistry contract address", default: "(optional)", required: false },
      { key: "MEMBERSHIP_SBT_CONTRACT_ID", description: "MembershipSBT contract address", default: "(optional)", required: false },
      { key: "BRIDGE_CONTRACT_ID", description: "Bridge contract address", default: "(optional)", required: false },
      { key: "CIRCUIT_REGISTRY_CONTRACT_ID", description: "CircuitRegistry contract address", default: "(optional)", required: false },
    ],
    "VK Version": [
      { key: "VOTING_VK_VERSION", description: "Static VK version override (0 = auto)", default: "0", required: false },
    ],
    "CORS": [
      { key: "CORS_ORIGIN", description: "Comma-separated allowed origins", default: "* (all origins)", required: false },
    ],
    "Logging": [
      { key: "LOG_CLIENT_IP", description: "IP logging: 'plain' | 'hash' (omit = skip)", default: "(skip)", required: false },
      { key: "LOG_REQUEST_BODY", description: "Log request body keys", default: "true", required: false },
      { key: "STRIP_REQUEST_BODIES", description: "Reject requests with body (test safety)", default: "false", required: false },
      { key: "RELAYER_GENERIC_ERRORS", description: "Suppress error details in responses", default: "false", required: false },
      { key: "HEALTH_EXPOSE_DETAILS", description: "Expose detailed health info", default: "true", required: false },
      { key: "HEALTHCHECK_PING", description: "Ping RPC on /health", default: "false", required: false },
    ],
    "Event Indexer": [
      { key: "INDEXER_ENABLED", description: "Enable event indexer polling", default: "true", required: false },
      { key: "INDEXER_POLL_INTERVAL_MS", description: "Polling interval in ms", default: "5000", required: false },
    ],
    "DAO Sync": [
      { key: "DAO_SYNC_INTERVAL_MS", description: "DAO metadata sync interval", default: "30000", required: false },
    ],
    "Membership Sync": [
      { key: "MEMBERSHIP_SYNC_INTERVAL_MS", description: "Membership state sync interval", default: "600000", required: false },
    ],
    "IPFS / Pinata": [
      { key: "PINATA_JWT", description: "Pinata API JWT", default: "(optional)", required: false },
      { key: "PINATA_GATEWAY", description: "Custom Pinata gateway URL", default: "gateway.pinata.cloud", required: false },
    ],
    "IPFS Pin Redundancy": [
      { key: "IPFS_BACKUP_DIR", description: "Local backup directory", default: "./data/ipfs-backup", required: false },
      { key: "WEB3_STORAGE_TOKEN", description: "Web3.Storage API token", default: "(optional)", required: false },
      { key: "PIN_VERIFY_INTERVAL_MS", description: "Pin verification scan interval", default: "3600000", required: false },
      { key: "PIN_ALERT_THRESHOLD", description: "Failures before alerting", default: "3", required: false },
      { key: "PIN_AUTO_REPIN", description: "Auto re-pin failed content", default: "true", required: false },
    ],
    "Anti-Spam: Proof of Work": [
      { key: "POW_ENABLED", description: "Enable PoW anti-spam", default: "true", required: false },
      { key: "POW_DIFFICULTY", description: "PoW difficulty", default: "20", required: false },
      { key: "POW_CHALLENGE_TTL_MS", description: "PoW challenge TTL", default: "300000", required: false },
    ],
    "Anti-Spam: Rate Limiting": [
      { key: "COMMITMENT_RATE_LIMIT", description: "Max commitments per window", default: "5", required: false },
      { key: "COMMITMENT_RATE_WINDOW_MS", description: "Rate limit window", default: "60000", required: false },
    ],
    "Anti-Spam: Community Flagging": [
      { key: "FLAG_THRESHOLD", description: "Flags to trigger action", default: "3", required: false },
      { key: "FLAG_POW_DIFFICULTY", description: "PoW difficulty for flags", default: "10", required: false },
    ],
    "TTL Renewal": [
      { key: "TTL_RENEWAL_INTERVAL_MS", description: "Renewal check interval", default: "604800000", required: false },
      { key: "TTL_RENEWAL_THRESHOLD_MS", description: "Renewal threshold", default: "1209600000", required: false },
      { key: "TTL_GRACE_PERIOD_MS", description: "Grace period", default: "259200000", required: false },
      { key: "TTL_BATCH_SIZE", description: "Max renewals per batch", default: "5", required: false },
      { key: "TTL_CHECK_ENABLED", description: "Enable periodic TTL checks", default: "true", required: false },
      { key: "TTL_COST_TRACKING_ENABLED", description: "Track TTL costs", default: "true", required: false },
      { key: "TTL_MAX_FEE", description: "Max fee for TTL renewal", default: "1000000", required: false },
      { key: "TTL_SLIPPAGE_LEDGERS", description: "Ledger slippage safety", default: "8640", required: false },
    ],
    "Backup & Archival": [
      { key: "BACKUP_INTERVAL_MS", description: "Backup interval", default: "86400000", required: false },
      { key: "BACKUP_S3_BUCKET", description: "S3 bucket for backups", default: "(optional)", required: false },
      { key: "ARCHIVAL_AGE_DAYS", description: "Days before archival", default: "90", required: false },
      { key: "ARCHIVAL_INTERVAL_MS", description: "Archival check interval", default: "86400000", required: false },
    ],
    "Circuit Breakers": [
      { key: "CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD", description: "RPC failures before open", default: "5", required: false },
      { key: "CIRCUIT_BREAKER_RPC_RESET_MS", description: "RPC circuit reset", default: "30000", required: false },
      { key: "CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD", description: "Pinata failures before open", default: "5", required: false },
      { key: "CIRCUIT_BREAKER_PINATA_RESET_MS", description: "Pinata circuit reset", default: "30000", required: false },
      { key: "CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD", description: "Gateway failures before open", default: "5", required: false },
      { key: "CIRCUIT_BREAKER_GATEWAY_RESET_MS", description: "Gateway circuit reset", default: "30000", required: false },
    ],
    "Memory Monitoring": [
      { key: "MEMORY_MONITOR_INTERVAL_MS", description: "Memory check interval", default: "60000", required: false },
      { key: "MEMORY_LIMIT_MB", description: "Container memory limit (MB)", default: "512", required: false },
      { key: "MEMORY_WARN_RATIO", description: "Warning threshold ratio", default: "0.8", required: false },
      { key: "MEMORY_CRITICAL_RATIO", description: "Critical threshold ratio", default: "0.95", required: false },
      { key: "MEMORY_AUTO_RESTART", description: "Auto-restart on critical memory", default: "true", required: false },
    ],
    "Cache": [
      { key: "MAX_CACHED_DAOS", description: "Max DAOs cached", default: "5000", required: false },
      { key: "DB_QUERY_CACHE_MAX_ENTRIES", description: "Max DB cache entries", default: "500", required: false },
    ],
    "Logging Sampling (NEW)": [
      { key: "LOG_SAMPLING_RATE", description: "Default sampling rate (0.0-1.0)", default: "0.1", required: false },
      { key: "LOG_SAMPLING_ERROR_RATE", description: "Error response sampling (recommend 1.0)", default: "1.0", required: false },
      { key: "LOG_SAMPLING_SLOW_RATE", description: "Slow request sampling (recommend 1.0)", default: "1.0", required: false },
      { key: "LOG_SLOW_THRESHOLD_MS", description: "Slow request threshold (ms)", default: "1000", required: false },
      { key: "LOG_BODY_MAX_CHARS", description: "Max chars logged from bodies", default: "2000", required: false },
    ],
    "Test Mode": [
      { key: "RELAYER_TEST_MODE", description: "Enable test mode", default: "false", required: false },
    ],
    "Hot-Reload": [
      { key: "HOT_RELOAD_ENABLED", description: "Enable config hot-reload", default: "false", required: false },
    ],
  };

  for (const [category, vars] of Object.entries(categories)) {
    lines.push(`# ── ${category} ${"─".repeat(Math.max(0, 40 - category.length))}`);

    for (const v of vars) {
      lines.push(`# ${v.description}`);
      if (v.required) {
        lines.push(`${v.key}=${v.default}`);
      } else {
        lines.push(`# ${v.key}=${v.default}`);
      }
      lines.push("");
    }
  }

  lines.push("# ============================================");
  lines.push("# BN254 CONSTANTS (DO NOT CHANGE)");
  lines.push("# ============================================");
  lines.push("# BN254 scalar field modulus (Fr):");
  lines.push("# 21888242871839275222246405745257275088548364400416034343698204186575808495617");
  lines.push("# BN254 base field modulus (Fq):");
  lines.push("# 21888242871839275222246405745257275088696311157297823662689037894645226208583");
  lines.push("");

  return lines.join("\n");
}

// ============================================
// SECRETS MASKING
// ============================================

/** Keys whose values must never be logged in plain text */
const SECRET_KEYS = new Set([
  "RELAYER_AUTH_TOKEN",
  "RELAYER_SECRET_KEY",
  "PINATA_JWT",
  "WEB3_STORAGE_TOKEN",
  "BACKUP_S3_BUCKET",
  "S3_BUCKET",
]);

/**
 * Return a copy of the raw config with secret values masked.
 * Used for /config display and diagnostic logging.
 */
export function maskSecrets(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const masked: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_KEYS.has(key) && value) {
      masked[key] = `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

// ============================================
// CONFIG CHANGE DETECTION
// ============================================

/** Snapshot of config for change detection */
export type ConfigSnapshot = Record<string, string | undefined>;

/**
 * Detect and report differences between two config snapshots.
 * Returns a list of changed variables with old → new values (secrets masked).
 */
export function detectConfigChanges(
  previous: ConfigSnapshot,
  current: ConfigSnapshot,
): Array<{ key: string; old: string | undefined; new: string | undefined }> {
  const changes: Array<{ key: string; old: string | undefined; new: string | undefined }> = [];
  const allKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);

  for (const key of allKeys) {
    if (previous[key] !== current[key]) {
      changes.push({
        key,
        old: SECRET_KEYS.has(key) ? "***" : previous[key],
        new: SECRET_KEYS.has(key) ? "***" : current[key],
      });
    }
  }

  return changes;
}

// ============================================
// HOT-RELOAD SUPPORT
// ============================================

/** Settings that can be changed without restarting */
const HOT_RELOAD_KEYS = new Set([
  "LOG_REQUEST_BODY",
  "LOG_CLIENT_IP",
  "LOG_SAMPLING_RATE",
  "LOG_SAMPLING_ERROR_RATE",
  "LOG_SAMPLING_SLOW_RATE",
  "LOG_SLOW_THRESHOLD_MS",
  "LOG_BODY_MAX_CHARS",
  "HEALTH_EXPOSE_DETAILS",
  "HEALTHCHECK_PING",
  "POW_DIFFICULTY",
  "FLAG_THRESHOLD",
  "FLAG_POW_DIFFICULTY",
  "MAX_CACHED_DAOS",
  "DB_QUERY_CACHE_MAX_ENTRIES",
]);

/**
 * Check if a config key is safe to hot-reload.
 */
export function isHotReloadable(key: string): boolean {
  return HOT_RELOAD_KEYS.has(key);
}

/**
 * Apply hot-reload changes to a config snapshot.
 * Returns a new snapshot with only hot-reloadable changes applied.
 */
export function applyHotReload(
  current: ConfigSnapshot,
  updates: ConfigSnapshot,
): ConfigSnapshot {
  const merged = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (HOT_RELOAD_KEYS.has(key)) {
      merged[key] = value;
    }
  }
  return merged;
}
