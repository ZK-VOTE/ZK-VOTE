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
import { z } from "zod";
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
// ENVIRONMENT SCHEMA (ZOD VALIDATION)
// ============================================
const envSchema = z.object({
    NODE_ENV: z
        .enum(["development", "production", "test"])
        .default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    CLUSTER_ENABLED: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    CLUSTER_WORKERS: z.coerce.number().int().positive().optional(),
    WORKER_COUNT: z.coerce.number().int().positive().optional(),
    WEB_CONCURRENCY: z.coerce.number().int().positive().optional(),
    SOROBAN_RPC_URL: z.string().url().optional(),
    SOROBAN_RPC_URLS: z.string().optional(),
    NETWORK_PASSPHRASE: z.string().optional(),
    RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    RELAYER_AUTH_TOKEN: z.string().optional(),
    RELAYER_SECRET_KEY: z.string().optional(),
    AUTH_MASTER_KEY: z.string().optional(),
    TOKEN_ROTATION_ENABLED: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    TOKEN_ROTATION_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(2592000000),
    TOKEN_ROTATION_TRANSITION_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(172800000),
    DEFAULT_TOKEN_LIFETIME_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(5184000000),
    TOKEN_AUDIT_LOG_ENABLED: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    VOTING_CONTRACT_ID: z.string().min(1).optional(),
    TREE_CONTRACT_ID: z.string().min(1).optional(),
    COMMENTS_CONTRACT_ID: z.string().min(1).optional(),
    DAO_REGISTRY_CONTRACT_ID: z.string().min(1).optional(),
    MEMBERSHIP_SBT_CONTRACT_ID: z.string().min(1).optional(),
    BRIDGE_CONTRACT_ID: z.string().min(1).optional(),
    CIRCUIT_REGISTRY_CONTRACT_ID: z.string().min(1).optional(),
    REWARDS_CONTRACT_ID: z.string().min(1).optional(),
    VOTING_VK_VERSION: z.coerce.number().int().optional(),
    CORS_ORIGIN: z.string().optional(),
    LOG_CLIENT_IP: z.enum(["plain", "hash"]).optional(),
    LOG_REQUEST_BODY: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    STRIP_REQUEST_BODIES: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    RELAYER_GENERIC_ERRORS: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    HEALTH_EXPOSE_DETAILS: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    HEALTHCHECK_PING: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    INDEXER_ENABLED: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    DAO_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
    MEMBERSHIP_SYNC_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(600000),
    PINATA_JWT: z.string().optional(),
    PINATA_GATEWAY: z.string().optional(),
    IPFS_SUBDOMAIN: z.string().optional(),
    IPFS_BACKUP_DIR: z.string().default("./data/ipfs-backup"),
    WEB3_STORAGE_TOKEN: z.string().optional(),
    PIN_VERIFY_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),
    PIN_ALERT_THRESHOLD: z.coerce.number().int().positive().default(3),
    PIN_AUTO_REPIN: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    POW_ENABLED: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    POW_DIFFICULTY: z.coerce.number().int().positive().default(20),
    POW_CHALLENGE_TTL_MS: z.coerce.number().int().positive().default(300000),
    COMMITMENT_RATE_LIMIT: z.coerce.number().int().positive().default(5),
    COMMITMENT_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    FLAG_THRESHOLD: z.coerce.number().int().positive().default(3),
    FLAG_POW_DIFFICULTY: z.coerce.number().int().positive().default(10),
    TTL_RENEWAL_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(604800000),
    TTL_RENEWAL_THRESHOLD_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(1209600000),
    TTL_GRACE_PERIOD_MS: z.coerce.number().int().positive().default(259200000),
    TTL_BATCH_SIZE: z.coerce.number().int().positive().default(5),
    TTL_CHECK_ENABLED: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    TTL_COST_TRACKING_ENABLED: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    TTL_MAX_FEE: z.string().default("1000000"),
    TTL_SLIPPAGE_LEDGERS: z.coerce.number().int().positive().default(8640),
    // Membership SBT transfer-attempt monitoring (#357)
    SBT_TRANSFER_WATCH_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(300000), // 5 minutes
    ADMIN_ALERT_WEBHOOK_URL: z.string().url().optional(),
    BACKUP_INTERVAL_MS: z.coerce.number().int().positive().default(86400000),
    BACKUP_S3_BUCKET: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    ARCHIVAL_AGE_DAYS: z.coerce.number().int().positive().default(90),
    ARCHIVAL_INTERVAL_MS: z.coerce.number().int().positive().default(86400000),
    AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    AUDIT_LOG_ROTATION_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(86400000),
    AUDIT_LOG_ARCHIVE_DIR: z.string().default("./data/audit-archive"),
    MAX_PROOF_AGE_SECONDS: z.coerce.number().int().positive().default(300),
    REQUIRE_CLIENT_CERT: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    WALLET_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    WALLET_RATE_LIMIT_WINDOW_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(60000),
    RELAYER_PUBLIC_KEY: z.string().default(""),
    CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD: z.coerce
        .number()
        .int()
        .positive()
        .default(5),
    CIRCUIT_BREAKER_RPC_RESET_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(30000),
    CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD: z.coerce
        .number()
        .int()
        .positive()
        .default(5),
    CIRCUIT_BREAKER_PINATA_RESET_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(30000),
    CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD: z.coerce
        .number()
        .int()
        .positive()
        .default(5),
    CIRCUIT_BREAKER_GATEWAY_RESET_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(30000),
    MEMORY_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
    MEMORY_LIMIT_MB: z.coerce.number().int().positive().default(512),
    MEMORY_WARN_RATIO: z.coerce.number().min(0).max(1).default(0.8),
    MEMORY_CRITICAL_RATIO: z.coerce.number().min(0).max(1).default(0.95),
    MEMORY_AUTO_RESTART: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v !== "false"),
    MAX_CACHED_DAOS: z.coerce.number().int().positive().default(5000),
    DB_QUERY_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
    DB_BUSY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    DB_CHECKPOINT_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
    DB_CHECKPOINT_TRANSACTION_COUNT: z.coerce
        .number()
        .int()
        .positive()
        .default(1000),
    DB_WAL_WARNING_THRESHOLD_BYTES: z.coerce
        .number()
        .int()
        .positive()
        .default(104857600),
    DB_BACKUP_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),
    DB_RETRY_COUNT: z.coerce.number().int().positive().default(5),
    DB_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(50),
    DB_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(2000),
    MAX_SEQUENCE_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(1),
    VOTE_SUBMISSION_PENDING_TTL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(300000),
    RELAYER_TEST_MODE: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
});
function validateBootEnv() {
    const parseResult = envSchema.safeParse(process.env);
    if (!parseResult.success) {
        const errors = parseResult.error.issues.map((issue) => {
            const field = issue.path.join(".");
            return `  ${field}: ${issue.message}`;
        });
        console.error(JSON.stringify({
            level: "error",
            event: "invalid_environment_config",
            errorCount: errors.length,
        }));
        console.error("\nInvalid environment configuration:");
        errors.forEach((e) => console.error(e));
        console.error("\nRun ./scripts/init-local.sh to generate backend/.env or configure your environment variables.");
        process.exit(1);
    }
    return parseResult.data;
}
// Validate environment on module load
const validatedEnv = validateBootEnv();
// ============================================
// VALIDATION HELPERS
// ============================================
/**
 * Validate Stellar contract ID format
 */
export function isValidContractId(contractId) {
    if (typeof contractId !== "string")
        return false;
    // Stellar contract IDs are 56-character C-addresses
    if (contractId.length !== 56)
        return false;
    if (!contractId.startsWith("C"))
        return false;
    // Base32 alphabet (uppercase)
    return /^C[A-Z2-7]{55}$/.test(contractId);
}
// ============================================
// CONFIGURATION
// ============================================
export const config = {
    // Environment
    NODE_ENV: validatedEnv.NODE_ENV,
    // Server
    port: validatedEnv.PORT,
    // Clustering
    clusterEnabled: validatedEnv.CLUSTER_ENABLED,
    clusterWorkers: Math.max(1, validatedEnv.CLUSTER_WORKERS ||
        validatedEnv.WORKER_COUNT ||
        validatedEnv.WEB_CONCURRENCY ||
        (typeof os.availableParallelism === "function"
            ? os.availableParallelism()
            : os.cpus().length) ||
        2),
    // Soroban RPC
    rpcUrl: validatedEnv.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc",
    rpcUrls: validatedEnv.SOROBAN_RPC_URLS
        ? validatedEnv.SOROBAN_RPC_URLS.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [validatedEnv.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc"],
    networkPassphrase: validatedEnv.NETWORK_PASSPHRASE || "Standalone Network ; February 2017",
    rpcTimeoutMs: validatedEnv.RPC_TIMEOUT_MS,
    shutdownDrainTimeoutMs: validatedEnv.SHUTDOWN_DRAIN_TIMEOUT_MS,
    // Authentication (read from env as fallback; see getSecret() for dynamic retrieval)
    relayerAuthToken: validatedEnv.RELAYER_AUTH_TOKEN,
    relayerSecretKey: validatedEnv.RELAYER_SECRET_KEY,
    // Master key for token management endpoints (REQUIRED - must be at least 32 chars)
    authMasterKey: validatedEnv.AUTH_MASTER_KEY,
    // Token rotation configuration
    tokenRotationEnabled: validatedEnv.TOKEN_ROTATION_ENABLED,
    tokenRotationIntervalMs: validatedEnv.TOKEN_ROTATION_INTERVAL_MS,
    tokenRotationTransitionMs: validatedEnv.TOKEN_ROTATION_TRANSITION_MS,
    defaultTokenLifetimeMs: validatedEnv.DEFAULT_TOKEN_LIFETIME_MS,
    // Audit logging
    tokenAuditLogEnabled: validatedEnv.TOKEN_AUDIT_LOG_ENABLED,
    // Contract IDs
    votingContractId: process.env.VOTING_CONTRACT_ID,
    treeContractId: process.env.TREE_CONTRACT_ID,
    commentsContractId: process.env.COMMENTS_CONTRACT_ID,
    daoRegistryContractId: process.env.DAO_REGISTRY_CONTRACT_ID,
    membershipSbtContractId: process.env.MEMBERSHIP_SBT_CONTRACT_ID,
    bridgeContractId: process.env.BRIDGE_CONTRACT_ID,
    circuitRegistryContractId: process.env.CIRCUIT_REGISTRY_CONTRACT_ID,
    // VK Version
    staticVkVersion: validatedEnv.VOTING_VK_VERSION,
    // CORS
    corsOrigins: validatedEnv.CORS_ORIGIN
        ? validatedEnv.CORS_ORIGIN.split(",").map((origin) => origin.trim())
        : "*",
    // Logging
    logClientIp: validatedEnv.LOG_CLIENT_IP,
    logRequestBody: validatedEnv.LOG_REQUEST_BODY,
    stripRequestBodies: validatedEnv.STRIP_REQUEST_BODIES,
    genericErrors: validatedEnv.RELAYER_GENERIC_ERRORS,
    healthExposeDetails: validatedEnv.HEALTH_EXPOSE_DETAILS,
    healthcheckPing: validatedEnv.HEALTHCHECK_PING,
    // Event Indexer
    indexerEnabled: validatedEnv.INDEXER_ENABLED,
    indexerPollIntervalMs: validatedEnv.INDEXER_POLL_INTERVAL_MS,
    // DAO Sync
    daoSyncIntervalMs: validatedEnv.DAO_SYNC_INTERVAL_MS,
    // Membership Sync
    membershipSyncIntervalMs: validatedEnv.MEMBERSHIP_SYNC_INTERVAL_MS,
    // IPFS/Pinata (read from env as fallback; see getSecret() for dynamic retrieval)
    pinataJwt: validatedEnv.PINATA_JWT,
    pinataGateway: validatedEnv.PINATA_GATEWAY,
    ipfsEnabled: !!validatedEnv.PINATA_JWT,
    ipfsSubdomain: validatedEnv.IPFS_SUBDOMAIN,
    // IPFS Pin Redundancy
    ipfsBackupDir: validatedEnv.IPFS_BACKUP_DIR,
    web3StorageToken: validatedEnv.WEB3_STORAGE_TOKEN,
    pinVerifyIntervalMs: validatedEnv.PIN_VERIFY_INTERVAL_MS,
    pinAlertThreshold: validatedEnv.PIN_ALERT_THRESHOLD,
    pinAutoRepin: validatedEnv.PIN_AUTO_REPIN,
    // Anti-spam: proof-of-work
    powEnabled: validatedEnv.POW_ENABLED,
    powDifficulty: validatedEnv.POW_DIFFICULTY,
    powChallengeTtlMs: validatedEnv.POW_CHALLENGE_TTL_MS,
    // Anti-spam: per-commitment rate limiting
    commitmentRateLimit: validatedEnv.COMMITMENT_RATE_LIMIT,
    commitmentRateWindowMs: validatedEnv.COMMITMENT_RATE_WINDOW_MS,
    // Anti-spam: community flagging
    flagThreshold: validatedEnv.FLAG_THRESHOLD,
    flagPowDifficulty: validatedEnv.FLAG_POW_DIFFICULTY,
    // TTL Renewal Optimization
    ttlRenewalIntervalMs: validatedEnv.TTL_RENEWAL_INTERVAL_MS,
    ttlRenewalThresholdMs: validatedEnv.TTL_RENEWAL_THRESHOLD_MS,
    ttlGracePeriodMs: validatedEnv.TTL_GRACE_PERIOD_MS,
    ttlBatchSize: validatedEnv.TTL_BATCH_SIZE,
    ttlCheckEnabled: validatedEnv.TTL_CHECK_ENABLED,
    ttlCostTrackingEnabled: validatedEnv.TTL_COST_TRACKING_ENABLED,
    ttlMaxFee: validatedEnv.TTL_MAX_FEE,
    ttlSlippageLedgers: validatedEnv.TTL_SLIPPAGE_LEDGERS,
    // Membership SBT transfer-attempt monitoring (#357)
    sbtTransferWatchIntervalMs: validatedEnv.SBT_TRANSFER_WATCH_INTERVAL_MS,
    adminAlertWebhookUrl: validatedEnv.ADMIN_ALERT_WEBHOOK_URL,
    // Backup & Archival
    backupIntervalMs: validatedEnv.BACKUP_INTERVAL_MS,
    s3Bucket: validatedEnv.BACKUP_S3_BUCKET || validatedEnv.S3_BUCKET,
    archivalAgeDays: validatedEnv.ARCHIVAL_AGE_DAYS,
    archivalIntervalMs: validatedEnv.ARCHIVAL_INTERVAL_MS,
    // Audit log rotation and archival
    auditLogRetentionDays: validatedEnv.AUDIT_LOG_RETENTION_DAYS,
    auditLogRotationIntervalMs: validatedEnv.AUDIT_LOG_ROTATION_INTERVAL_MS,
    auditLogArchiveDir: validatedEnv.AUDIT_LOG_ARCHIVE_DIR,
    // Proof Security & Mitigations
    maxProofAgeSeconds: validatedEnv.MAX_PROOF_AGE_SECONDS,
    requireClientCert: validatedEnv.REQUIRE_CLIENT_CERT,
    walletRateLimitMax: validatedEnv.WALLET_RATE_LIMIT_MAX,
    walletRateLimitWindowMs: validatedEnv.WALLET_RATE_LIMIT_WINDOW_MS,
    relayerPublicKey: validatedEnv.RELAYER_PUBLIC_KEY,
    // Circuit Breakers
    circuitBreakerRpcFailureThreshold: validatedEnv.CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD,
    circuitBreakerRpcResetMs: validatedEnv.CIRCUIT_BREAKER_RPC_RESET_MS,
    circuitBreakerPinataFailureThreshold: validatedEnv.CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD,
    circuitBreakerPinataResetMs: validatedEnv.CIRCUIT_BREAKER_PINATA_RESET_MS,
    circuitBreakerGatewayFailureThreshold: validatedEnv.CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD,
    circuitBreakerGatewayResetMs: validatedEnv.CIRCUIT_BREAKER_GATEWAY_RESET_MS,
    // Memory monitoring
    memoryMonitorIntervalMs: validatedEnv.MEMORY_MONITOR_INTERVAL_MS,
    memoryLimitMb: validatedEnv.MEMORY_LIMIT_MB,
    memoryWarnRatio: validatedEnv.MEMORY_WARN_RATIO,
    memoryCriticalRatio: validatedEnv.MEMORY_CRITICAL_RATIO,
    memoryAutoRestart: validatedEnv.MEMORY_AUTO_RESTART,
    // Cache eviction bounds
    maxCachedDaos: validatedEnv.MAX_CACHED_DAOS,
    dbQueryCacheMaxEntries: validatedEnv.DB_QUERY_CACHE_MAX_ENTRIES,
    // Database / WAL Resilience
    dbBusyTimeoutMs: validatedEnv.DB_BUSY_TIMEOUT_MS,
    dbCheckpointIntervalMs: validatedEnv.DB_CHECKPOINT_INTERVAL_MS,
    dbCheckpointTransactionCount: validatedEnv.DB_CHECKPOINT_TRANSACTION_COUNT,
    dbWalWarningThresholdBytes: validatedEnv.DB_WAL_WARNING_THRESHOLD_BYTES,
    dbBackupIntervalMs: validatedEnv.DB_BACKUP_INTERVAL_MS,
    dbRetryCount: validatedEnv.DB_RETRY_COUNT,
    dbRetryBaseDelayMs: validatedEnv.DB_RETRY_BASE_DELAY_MS,
    dbRetryMaxDelayMs: validatedEnv.DB_RETRY_MAX_DELAY_MS,
    // Sequence manager
    maxSequenceRetryAttempts: validatedEnv.MAX_SEQUENCE_RETRY_ATTEMPTS,
    // Vote submission idempotency
    voteSubmissionPendingTtlMs: validatedEnv.VOTE_SUBMISSION_PENDING_TTL_MS,
    // Test mode
    testMode: validatedEnv.RELAYER_TEST_MODE,
};
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
};
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
];
// ============================================
// BN254 CONSTANTS
// ============================================
// BN254 field modulus (p)
export const BN254_MODULUS = BigInt("218882428718392752222464057452572750885483644004160343698204186575808495617");
// BN254 scalar field modulus (r)
export const BN254_SCALAR_FIELD = BigInt("0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47");
// ============================================
// ENVIRONMENT VALIDATION
// ============================================
/**
 * Validate required environment variables and business logic constraints.
 * Zod validates structural/type constraints on module load; this function
 * validates business logic (required fields, contract ID format, key strength).
 * Throws if validation fails.
 */
export function validateEnv() {
    const errors = [];
    if (!config.votingContractId)
        errors.push("VOTING_CONTRACT_ID is required");
    if (!config.treeContractId)
        errors.push("TREE_CONTRACT_ID is required");
    if (!config.commentsContractId)
        errors.push("COMMENTS_CONTRACT_ID is required");
    if (!config.relayerSecretKey)
        errors.push("RELAYER_SECRET_KEY is required");
    if (!config.authMasterKey)
        errors.push("AUTH_MASTER_KEY is required");
    if (config.votingContractId && !isValidContractId(config.votingContractId)) {
        errors.push(`VOTING_CONTRACT_ID "${config.votingContractId}" is not a valid Stellar contract ID (must be 56-char C-address)`);
    }
    if (config.treeContractId && !isValidContractId(config.treeContractId)) {
        errors.push(`TREE_CONTRACT_ID "${config.treeContractId}" is not a valid Stellar contract ID`);
    }
    const criticalKeys = ["VOTING_CONTRACT_ID", "TREE_CONTRACT_ID", "RELAYER_SECRET_KEY", "RELAYER_AUTH_TOKEN"];
    const criticalMissing = missing.filter((k) => criticalKeys.includes(k));
    const nonCriticalMissing = missing.filter((k) => !criticalKeys.includes(k));
    if (criticalMissing.length > 0) {
        console.error(JSON.stringify({ level: "error", event: "missing_env", missing: criticalMissing }));
    }
    if (nonCriticalMissing.length > 0) {
        if (config.testMode) {
            console.warn(JSON.stringify({ level: "warn", event: "missing_optional_env_in_test_mode", missing: nonCriticalMissing }));
        }
        else {
            console.error(JSON.stringify({ level: "error", event: "missing_env", missing: nonCriticalMissing }));
            console.error("\nRun ./scripts/init-local.sh to generate backend/.env");
            process.exit(1);
        }
    }
    // Validate auth token strength (minimum 32 characters for security)
    // Skip validation in test mode since tests set short tokens for convenience
    if (config.relayerAuthToken &&
        config.relayerAuthToken.length < 32 &&
        !config.testMode) {
        errors.push("RELAYER_AUTH_TOKEN must be at least 32 characters (not in test mode)");
    }
    if (errors.length > 0) {
        console.error(JSON.stringify({
            level: "error",
            event: "env_validation_failed",
            errorCount: errors.length,
        }));
        console.error("\nEnvironment validation errors:");
        errors.forEach((e) => console.error(`  - ${e}`));
        console.error("\nRun ./scripts/init-local.sh to generate backend/.env or configure your environment variables.");
        process.exit(1);
    }
    const isProd = config.NODE_ENV === "production";
    if (!isProd &&
        config.relayerSecretKey &&
        config.relayerSecretKey.startsWith("S") &&
        config.relayerSecretKey.length === 56 &&
        !config.testMode &&
        config.relayerSecretKey !==
            "SCZANGBA5AKIA7VTJQXBDKPQOBFZD3NWKNR3CQULPSFMJUADSHWFUCS") {
        console.warn(JSON.stringify({
            level: "warn",
            event: "production_secret_in_non_prod",
        }));
        console.warn("WARNING: A valid Stellar Secret Key is being used in a non-production environment.");
    }
    if (config.commentsContractId && !isValidContractId(config.commentsContractId)) {
        console.error(JSON.stringify({
            level: "error",
            event: "invalid_contract_id",
            var: "REWARDS_CONTRACT_ID",
            value: config.rewardsContractId,
        }));
        process.exit(1);
    }
    // In test mode, missing comments contract is allowed (warned above, not fatal)
}
//# sourceMappingURL=config.js.map