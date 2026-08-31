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
  RELAYER_SIGNER_TYPE: z
    .enum(["local", "aws_kms", "gcp_kms", "pkcs11"])
    .default("local"),
  RELAYER_PUBLIC_KEY: z.string().optional(),
  KMS_KEY_ID: z.string().optional(),
  KMS_REGION: z.string().optional(),
  KMS_PROVIDER: z.string().optional(),
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
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).default("zkvote-relayer"),
  OTEL_SDK_DISABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  OTEL_EXPORT_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  LOG_CLIENT_IP: z.enum(["plain", "hash"]).optional(),
  LOG_REQUEST_BODY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v !== "false"),
  STRIP_REQUEST_BODIES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
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

  // Logging Sampling
  LOG_SAMPLING_RATE: z.coerce.number().min(0).max(1).default(0.1),
  LOG_SAMPLING_ERROR_RATE: z.coerce.number().min(0).max(1).default(1.0),
  LOG_SAMPLING_SLOW_RATE: z.coerce.number().min(0).max(1).default(1.0),
  LOG_SLOW_THRESHOLD_MS: z.coerce.number().int().positive().default(1000),
  LOG_BODY_MAX_CHARS: z.coerce.number().int().positive().default(2000),

  // Hot-Reload
  HOT_RELOAD_ENABLED: z
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

  // #371: per-member commitment registration rate limit (relayer route).
  // Mirrors the on-chain per-member cooldown in the membership-tree contract.
  COMMITMENT_REGISTRATION_RATE_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  COMMITMENT_REGISTRATION_RATE_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60000),

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
  // Encrypted relay DB snapshots (#359)
  BACKUP_ENCRYPTION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  BACKUP_ENCRYPTION_AUTO_INIT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  BACKUP_ENCRYPTION_KEY: z.string().optional(),
  BACKUP_ENCRYPTION_KEY_FILE: z.string().optional(),
  BACKUP_KEY_RING_DIR: z.string().optional(),
  BACKUP_RETENTION_COUNT: z.coerce.number().int().positive().default(10),
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
  MAX_SPONSORED_FEE_STROOPS: z.coerce
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .default(100000),

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

  // Submit Queue (for bounded concurrency and backpressure)
  SUBMIT_QUEUE_MAX_DEPTH: z.coerce.number().int().positive().default(100),
  SUBMIT_QUEUE_ITEM_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120000), // 2 minutes

  // RPC Concurrency Limits
  RPC_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().positive().default(10),

  // Cache TTLs (for memory bounding)
  NULLIFIER_CACHE_TTL_MS: z.coerce.number().int().positive().default(600000), // 10 minutes
  PROOF_CACHE_TTL_MS: z.coerce.number().int().positive().default(600000), // 10 minutes
  MEMBERSHIP_CACHE_TTL_MS: z.coerce.number().int().positive().default(300000), // 5 minutes
  NULLIFIER_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(10000),
  PROOF_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(5000),

  MAX_SEQUENCE_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(1),
  VOTE_SUBMISSION_PENDING_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300000),
  VOTE_QUEUE_MAX_DEPTH: z.coerce.number().int().positive().default(100),

  RELAYER_TEST_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  DECENTRALIZED_RELAY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  MPC_QUORUM_SIZE: z.coerce.number().int().positive().default(3),
  MPC_RELAY_NODE_URLS: z.string().optional(),
  COVER_TRAFFIC_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  COVER_TRAFFIC_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  COVER_TRAFFIC_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  MISSING_VOTE_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  MISSING_VOTE_MONITOR_THRESHOLD: z.coerce.number().int().positive().default(3),
  ANONYMOUS_SUBMISSION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v !== "false"),
});

type EnvConfig = z.infer<typeof envSchema>;

function validateBootEnv(): EnvConfig {
  const parseResult = envSchema.safeParse(process.env);

  if (!parseResult.success) {
    const errors = parseResult.error.issues.map((issue) => {
      const field = issue.path.join(".");
      return `  ${field}: ${issue.message}`;
    });

    console.error(
      JSON.stringify({
        level: "error",
        event: "invalid_environment_config",
        errorCount: errors.length,
      }),
    );
    console.error("\nInvalid environment configuration:");
    errors.forEach((e) => console.error(e));
    console.error(
      "\nRun ./scripts/init-local.sh to generate backend/.env or configure your environment variables.",
    );
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
  // Environment
  NODE_ENV: validatedEnv.NODE_ENV,

  // Server
  port: validatedEnv.PORT,
  otelExporterOtlpEndpoint: validatedEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
  otelServiceName: validatedEnv.OTEL_SERVICE_NAME,
  otelSdkDisabled: validatedEnv.OTEL_SDK_DISABLED,
  otelExportTimeoutMs: validatedEnv.OTEL_EXPORT_TIMEOUT_MS,

  // Clustering
  clusterEnabled: validatedEnv.CLUSTER_ENABLED,
  clusterWorkers: Math.max(
    1,
    validatedEnv.CLUSTER_WORKERS ||
      validatedEnv.WORKER_COUNT ||
      validatedEnv.WEB_CONCURRENCY ||
      (typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length) ||
      2,
  ),

  // Soroban RPC
  rpcUrl: validatedEnv.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc",
  rpcUrls: validatedEnv.SOROBAN_RPC_URLS
    ? validatedEnv.SOROBAN_RPC_URLS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [validatedEnv.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc"],
  networkPassphrase:
    validatedEnv.NETWORK_PASSPHRASE || "Standalone Network ; February 2017",
  rpcTimeoutMs: validatedEnv.RPC_TIMEOUT_MS,
  shutdownDrainTimeoutMs: validatedEnv.SHUTDOWN_DRAIN_TIMEOUT_MS,

  // Authentication (read from env as fallback; see getSecret() for dynamic retrieval)
  relayerAuthToken: validatedEnv.RELAYER_AUTH_TOKEN,
  relayerSecretKey: validatedEnv.RELAYER_SECRET_KEY,
  relayerSignerType: validatedEnv.RELAYER_SIGNER_TYPE,
  relayerPublicKey: validatedEnv.RELAYER_PUBLIC_KEY,
  kmsKeyId: validatedEnv.KMS_KEY_ID,
  kmsRegion: validatedEnv.KMS_REGION,
  kmsProvider: validatedEnv.KMS_PROVIDER,

  // Decentralized relay network (MPC submitter + cover traffic)
  decentralizedRelayEnabled: validatedEnv.DECENTRALIZED_RELAY_ENABLED,
  mpcQuorumSize: validatedEnv.MPC_QUORUM_SIZE,
  mpcRelayNodeUrls: validatedEnv.MPC_RELAY_NODE_URLS
    ? validatedEnv.MPC_RELAY_NODE_URLS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [],
  coverTrafficEnabled: validatedEnv.COVER_TRAFFIC_ENABLED,
  coverTrafficIntervalMs: validatedEnv.COVER_TRAFFIC_INTERVAL_MS,
  coverTrafficBatchSize: validatedEnv.COVER_TRAFFIC_BATCH_SIZE,
  missingVoteMonitorIntervalMs: validatedEnv.MISSING_VOTE_MONITOR_INTERVAL_MS,
  missingVoteMonitorThreshold: validatedEnv.MISSING_VOTE_MONITOR_THRESHOLD,
  anonymousSubmissionEnabled: validatedEnv.ANONYMOUS_SUBMISSION_ENABLED,

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
  votingContractId: validatedEnv.VOTING_CONTRACT_ID,
  treeContractId: validatedEnv.TREE_CONTRACT_ID,
  commentsContractId: validatedEnv.COMMENTS_CONTRACT_ID,
  daoRegistryContractId: validatedEnv.DAO_REGISTRY_CONTRACT_ID,
  membershipSbtContractId: validatedEnv.MEMBERSHIP_SBT_CONTRACT_ID,
  bridgeContractId: validatedEnv.BRIDGE_CONTRACT_ID,
  circuitRegistryContractId: validatedEnv.CIRCUIT_REGISTRY_CONTRACT_ID,
  rewardsContractId: validatedEnv.REWARDS_CONTRACT_ID,

  // VK Version
  staticVkVersion: validatedEnv.VOTING_VK_VERSION,

  // CORS
  corsOrigins: validatedEnv.CORS_ORIGIN
    ? validatedEnv.CORS_ORIGIN.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : (["*"] as string[]),
  corsAllowedMethods: ["GET", "POST", "OPTIONS"] as string[],
  corsAllowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-CSRF-Token",
  ] as string[],
  corsMaxAge: 3600,

  // Logging
  logClientIp: validatedEnv.LOG_CLIENT_IP,
  logRequestBody: validatedEnv.LOG_REQUEST_BODY,
  stripRequestBodies: validatedEnv.STRIP_REQUEST_BODIES,
  logSampleRate: validatedEnv.LOG_SAMPLE_RATE,
  genericErrors: validatedEnv.RELAYER_GENERIC_ERRORS,
  healthExposeDetails: validatedEnv.HEALTH_EXPOSE_DETAILS,
  healthcheckPing: validatedEnv.HEALTHCHECK_PING,

  // Logging Sampling
  logSamplingRate: validatedEnv.LOG_SAMPLING_RATE,
  logSamplingErrorRate: validatedEnv.LOG_SAMPLING_ERROR_RATE,
  logSamplingSlowRate: validatedEnv.LOG_SAMPLING_SLOW_RATE,
  logSlowThresholdMs: validatedEnv.LOG_SLOW_THRESHOLD_MS,
  logBodyMaxChars: validatedEnv.LOG_BODY_MAX_CHARS,

  // Hot-Reload
  hotReloadEnabled: validatedEnv.HOT_RELOAD_ENABLED,

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

  // Anti-spam: per-member commitment registration rate limiting (#371)
  commitmentRegistrationRateLimit:
    validatedEnv.COMMITMENT_REGISTRATION_RATE_LIMIT,
  commitmentRegistrationRateWindowMs:
    validatedEnv.COMMITMENT_REGISTRATION_RATE_WINDOW_MS,

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
  // Encrypted relay DB snapshots (#359)
  backupEncryptionEnabled: validatedEnv.BACKUP_ENCRYPTION_ENABLED,
  backupEncryptionAutoInit: validatedEnv.BACKUP_ENCRYPTION_AUTO_INIT,
  backupEncryptionKey: validatedEnv.BACKUP_ENCRYPTION_KEY,
  backupEncryptionKeyFile: validatedEnv.BACKUP_ENCRYPTION_KEY_FILE,
  backupKeyRingDir: validatedEnv.BACKUP_KEY_RING_DIR,
  backupRetentionCount: validatedEnv.BACKUP_RETENTION_COUNT,
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
  maxSponsoredFeeStroops: validatedEnv.MAX_SPONSORED_FEE_STROOPS,
  // Circuit Breakers
  circuitBreakerRpcFailureThreshold:
    validatedEnv.CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD,
  circuitBreakerRpcResetMs: validatedEnv.CIRCUIT_BREAKER_RPC_RESET_MS,
  circuitBreakerPinataFailureThreshold:
    validatedEnv.CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD,
  circuitBreakerPinataResetMs: validatedEnv.CIRCUIT_BREAKER_PINATA_RESET_MS,
  circuitBreakerGatewayFailureThreshold:
    validatedEnv.CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD,
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

  // Submit Queue
  submitQueueMaxDepth: validatedEnv.SUBMIT_QUEUE_MAX_DEPTH,
  submitQueueItemTimeoutMs: validatedEnv.SUBMIT_QUEUE_ITEM_TIMEOUT_MS,

  // RPC Concurrency
  rpcMaxConcurrentRequests: validatedEnv.RPC_MAX_CONCURRENT_REQUESTS,

  // Cache TTLs
  nullifierCacheTtlMs: validatedEnv.NULLIFIER_CACHE_TTL_MS,
  proofCacheTtlMs: validatedEnv.PROOF_CACHE_TTL_MS,
  membershipCacheTtlMs: validatedEnv.MEMBERSHIP_CACHE_TTL_MS,
  nullifierCacheMaxEntries: validatedEnv.NULLIFIER_CACHE_MAX_ENTRIES,
  proofCacheMaxEntries: validatedEnv.PROOF_CACHE_MAX_ENTRIES,

  // Sequence manager
  maxSequenceRetryAttempts: validatedEnv.MAX_SEQUENCE_RETRY_ATTEMPTS,

  // Vote submission idempotency
  voteSubmissionPendingTtlMs: validatedEnv.VOTE_SUBMISSION_PENDING_TTL_MS,
  voteQueueMaxDepth: validatedEnv.VOTE_QUEUE_MAX_DEPTH,

  // Test mode
  testMode: validatedEnv.RELAYER_TEST_MODE,
} as const;

export const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    if (
      !origin ||
      config.corsOrigins.includes(origin) ||
      config.corsOrigins.includes("*")
    ) {
      callback(null, true);
      return;
    }
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "cors_origin_rejected",
        origin,
      }),
    );
    callback(null, false);
  },
  methods: config.corsAllowedMethods,
  allowedHeaders: config.corsAllowedHeaders,
  maxAge: config.corsMaxAge,
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
 * Validate required environment variables and business logic constraints.
 * Zod validates structural/type constraints on module load; this function
 * validates business logic (required fields, contract ID format, key strength).
 * Throws if validation fails.
 */
export function validateEnv(): void {
  const errors: string[] = [];
  const missing: string[] = [];

  const isProduction = config.NODE_ENV === "production";
  if (isProduction) {
    const corsOrigins = config.corsOrigins;
    if (corsOrigins.length === 0 || corsOrigins.includes("*")) {
      errors.push(
        "CORS_ORIGIN must be set to explicit origins in production (no wildcards or regex)",
      );
    }
    for (const origin of corsOrigins) {
      if (origin === "*") continue;
      if (origin.includes("*") || origin.includes("?") || /[\[\]{}()|]/.test(origin)) {
        errors.push(
          `CORS_ORIGIN contains wildcard or regex pattern: "${origin}"`,
        );
        continue;
      }
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          errors.push(`CORS_ORIGIN is not a valid origin: "${origin}"`);
        }
      } catch {
        errors.push(`CORS_ORIGIN is not a valid origin: "${origin}"`);
      }
    }
  }

  if (!config.votingContractId) errors.push("VOTING_CONTRACT_ID is required");
  if (!config.treeContractId) errors.push("TREE_CONTRACT_ID is required");
  if (!config.commentsContractId)
    errors.push("COMMENTS_CONTRACT_ID is required");
  }
  if (!config.relayerSecretKey) {
    missing.push("RELAYER_SECRET_KEY");
    errors.push("RELAYER_SECRET_KEY is required");
  }
  if (!config.authMasterKey) {
    missing.push("AUTH_MASTER_KEY");
    errors.push("AUTH_MASTER_KEY is required");
  }

  if (config.votingContractId && !isValidContractId(config.votingContractId)) {
    errors.push(
      `VOTING_CONTRACT_ID "${config.votingContractId}" is not a valid Stellar contract ID (must be 56-char C-address)`,
    );
  }

  if (config.treeContractId && !isValidContractId(config.treeContractId)) {
    errors.push(
      `TREE_CONTRACT_ID "${config.treeContractId}" is not a valid Stellar contract ID`,
    );
  }

  const criticalKeys = ["VOTING_CONTRACT_ID", "TREE_CONTRACT_ID", "RELAYER_SECRET_KEY", "RELAYER_AUTH_TOKEN"];
  const missing: string[] = [
    ...errors.map((e) => e.split(" ")[0]).filter((k) => typeof k === "string"),
  ];
  const criticalMissing = missing.filter((k: string) => criticalKeys.includes(k));
  const nonCriticalMissing = missing.filter((k: string) => !criticalKeys.includes(k));

  if (criticalMissing.length > 0) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "missing_env",
        missing: criticalMissing,
      }),
    );
  }

  if (nonCriticalMissing.length > 0) {
    if (config.testMode) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "missing_optional_env_in_test_mode",
          missing: nonCriticalMissing,
        }),
      );
    } else {
      console.error(
        JSON.stringify({
          level: "error",
          event: "missing_env",
          missing: nonCriticalMissing,
        }),
      );
      console.error("\nRun ./scripts/init-local.sh to generate backend/.env");
      process.exit(1);
    }
  }

  // Validate auth token strength (minimum 32 characters for security)
  // Skip validation in test mode since tests set short tokens for convenience
  if (
    config.relayerAuthToken &&
    config.relayerAuthToken.length < 32 &&
    !config.testMode
  ) {
    errors.push(
      "RELAYER_AUTH_TOKEN must be at least 32 characters (not in test mode)",
    );
  }

  if (errors.length > 0) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "env_validation_failed",
        errorCount: errors.length,
      }),
    );
    console.error("\nEnvironment validation errors:");
    errors.forEach((e) => console.error(`  - ${e}`));
    console.error(
      "\nRun ./scripts/init-local.sh to generate backend/.env or configure your environment variables.",
    );
    process.exit(1);
  }

  const isProd = config.NODE_ENV === "production";
  if (
    !isProd &&
    config.relayerSecretKey &&
    config.relayerSecretKey.startsWith("S") &&
    config.relayerSecretKey.length === 56 &&
    !config.testMode &&
    config.relayerSecretKey !==
      "SCZANGBA5AKIA7VTJQXBDKPQOBFZD3NWKNR3CQULPSFMJUADSHWFUCS"
  ) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "production_secret_in_non_prod",
      }),
    );
    console.warn(
      "WARNING: A valid Stellar Secret Key is being used in a non-production environment.",
    );
  }

  if (
    config.commentsContractId &&
    !isValidContractId(config.commentsContractId)
  ) {
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

  if (
    config.rewardsContractId &&
    !isValidContractId(config.rewardsContractId)
  ) {
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

  if (config.rewardsContractId && !isValidContractId(config.rewardsContractId)) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "invalid_contract_id",
        var: "REWARDS_CONTRACT_ID",
        value: config.rewardsContractId,
      }),
    );
    process.exit(1);
  }
  // In test mode, missing comments contract is allowed (warned above, not fatal)
}
