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
export declare const configSchema: z.ZodObject<{
    PORT: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    SOROBAN_RPC_URL: z.ZodDefault<z.ZodString>;
    SOROBAN_RPC_URLS: z.ZodEffects<z.ZodOptional<z.ZodString>, string[] | undefined, string | undefined>;
    NETWORK_PASSPHRASE: z.ZodDefault<z.ZodString>;
    RPC_TIMEOUT_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    RELAYER_AUTH_TOKEN: z.ZodString;
    RELAYER_SECRET_KEY: z.ZodOptional<z.ZodString>;
    VOTING_CONTRACT_ID: z.ZodString;
    TREE_CONTRACT_ID: z.ZodString;
    COMMENTS_CONTRACT_ID: z.ZodString;
    DAO_REGISTRY_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    MEMBERSHIP_SBT_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    BRIDGE_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    CIRCUIT_REGISTRY_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    VOTING_VK_VERSION: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CORS_ORIGIN: z.ZodOptional<z.ZodString>;
    LOG_CLIENT_IP: z.ZodOptional<z.ZodEnum<["plain", "hash"]>>;
    LOG_REQUEST_BODY: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    STRIP_REQUEST_BODIES: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    RELAYER_GENERIC_ERRORS: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    HEALTH_EXPOSE_DETAILS: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    HEALTHCHECK_PING: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    INDEXER_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    INDEXER_POLL_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    DAO_SYNC_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMBERSHIP_SYNC_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    PINATA_JWT: z.ZodOptional<z.ZodString>;
    PINATA_GATEWAY: z.ZodOptional<z.ZodString>;
    IPFS_BACKUP_DIR: z.ZodDefault<z.ZodString>;
    WEB3_STORAGE_TOKEN: z.ZodOptional<z.ZodString>;
    PIN_VERIFY_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    PIN_ALERT_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    PIN_AUTO_REPIN: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    POW_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    POW_DIFFICULTY: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    POW_CHALLENGE_TTL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    COMMITMENT_RATE_LIMIT: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    COMMITMENT_RATE_WINDOW_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    FLAG_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    FLAG_POW_DIFFICULTY: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_RENEWAL_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_RENEWAL_THRESHOLD_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_GRACE_PERIOD_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_BATCH_SIZE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_CHECK_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    TTL_COST_TRACKING_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    TTL_MAX_FEE: z.ZodDefault<z.ZodString>;
    TTL_SLIPPAGE_LEDGERS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    BACKUP_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    BACKUP_S3_BUCKET: z.ZodOptional<z.ZodString>;
    S3_BUCKET: z.ZodOptional<z.ZodString>;
    ARCHIVAL_AGE_DAYS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    ARCHIVAL_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_RPC_RESET_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_PINATA_RESET_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_GATEWAY_RESET_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_MONITOR_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_LIMIT_MB: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_WARN_RATIO: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_CRITICAL_RATIO: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_AUTO_RESTART: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    MAX_CACHED_DAOS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    DB_QUERY_CACHE_MAX_ENTRIES: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    RELAYER_TEST_MODE: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    LOG_SAMPLING_RATE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_SAMPLING_ERROR_RATE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_SAMPLING_SLOW_RATE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_SLOW_THRESHOLD_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_BODY_MAX_CHARS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    HOT_RELOAD_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    PORT: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    SOROBAN_RPC_URL: z.ZodDefault<z.ZodString>;
    SOROBAN_RPC_URLS: z.ZodEffects<z.ZodOptional<z.ZodString>, string[] | undefined, string | undefined>;
    NETWORK_PASSPHRASE: z.ZodDefault<z.ZodString>;
    RPC_TIMEOUT_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    RELAYER_AUTH_TOKEN: z.ZodString;
    RELAYER_SECRET_KEY: z.ZodOptional<z.ZodString>;
    VOTING_CONTRACT_ID: z.ZodString;
    TREE_CONTRACT_ID: z.ZodString;
    COMMENTS_CONTRACT_ID: z.ZodString;
    DAO_REGISTRY_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    MEMBERSHIP_SBT_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    BRIDGE_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    CIRCUIT_REGISTRY_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    VOTING_VK_VERSION: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CORS_ORIGIN: z.ZodOptional<z.ZodString>;
    LOG_CLIENT_IP: z.ZodOptional<z.ZodEnum<["plain", "hash"]>>;
    LOG_REQUEST_BODY: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    STRIP_REQUEST_BODIES: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    RELAYER_GENERIC_ERRORS: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    HEALTH_EXPOSE_DETAILS: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    HEALTHCHECK_PING: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    INDEXER_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    INDEXER_POLL_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    DAO_SYNC_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMBERSHIP_SYNC_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    PINATA_JWT: z.ZodOptional<z.ZodString>;
    PINATA_GATEWAY: z.ZodOptional<z.ZodString>;
    IPFS_BACKUP_DIR: z.ZodDefault<z.ZodString>;
    WEB3_STORAGE_TOKEN: z.ZodOptional<z.ZodString>;
    PIN_VERIFY_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    PIN_ALERT_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    PIN_AUTO_REPIN: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    POW_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    POW_DIFFICULTY: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    POW_CHALLENGE_TTL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    COMMITMENT_RATE_LIMIT: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    COMMITMENT_RATE_WINDOW_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    FLAG_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    FLAG_POW_DIFFICULTY: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_RENEWAL_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_RENEWAL_THRESHOLD_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_GRACE_PERIOD_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_BATCH_SIZE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_CHECK_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    TTL_COST_TRACKING_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    TTL_MAX_FEE: z.ZodDefault<z.ZodString>;
    TTL_SLIPPAGE_LEDGERS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    BACKUP_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    BACKUP_S3_BUCKET: z.ZodOptional<z.ZodString>;
    S3_BUCKET: z.ZodOptional<z.ZodString>;
    ARCHIVAL_AGE_DAYS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    ARCHIVAL_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_RPC_RESET_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_PINATA_RESET_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_GATEWAY_RESET_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_MONITOR_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_LIMIT_MB: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_WARN_RATIO: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_CRITICAL_RATIO: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_AUTO_RESTART: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    MAX_CACHED_DAOS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    DB_QUERY_CACHE_MAX_ENTRIES: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    RELAYER_TEST_MODE: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    LOG_SAMPLING_RATE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_SAMPLING_ERROR_RATE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_SAMPLING_SLOW_RATE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_SLOW_THRESHOLD_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_BODY_MAX_CHARS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    HOT_RELOAD_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    PORT: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    SOROBAN_RPC_URL: z.ZodDefault<z.ZodString>;
    SOROBAN_RPC_URLS: z.ZodEffects<z.ZodOptional<z.ZodString>, string[] | undefined, string | undefined>;
    NETWORK_PASSPHRASE: z.ZodDefault<z.ZodString>;
    RPC_TIMEOUT_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    RELAYER_AUTH_TOKEN: z.ZodString;
    RELAYER_SECRET_KEY: z.ZodOptional<z.ZodString>;
    VOTING_CONTRACT_ID: z.ZodString;
    TREE_CONTRACT_ID: z.ZodString;
    COMMENTS_CONTRACT_ID: z.ZodString;
    DAO_REGISTRY_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    MEMBERSHIP_SBT_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    BRIDGE_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    CIRCUIT_REGISTRY_CONTRACT_ID: z.ZodOptional<z.ZodString>;
    VOTING_VK_VERSION: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CORS_ORIGIN: z.ZodOptional<z.ZodString>;
    LOG_CLIENT_IP: z.ZodOptional<z.ZodEnum<["plain", "hash"]>>;
    LOG_REQUEST_BODY: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    STRIP_REQUEST_BODIES: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    RELAYER_GENERIC_ERRORS: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    HEALTH_EXPOSE_DETAILS: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    HEALTHCHECK_PING: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    INDEXER_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    INDEXER_POLL_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    DAO_SYNC_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMBERSHIP_SYNC_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    PINATA_JWT: z.ZodOptional<z.ZodString>;
    PINATA_GATEWAY: z.ZodOptional<z.ZodString>;
    IPFS_BACKUP_DIR: z.ZodDefault<z.ZodString>;
    WEB3_STORAGE_TOKEN: z.ZodOptional<z.ZodString>;
    PIN_VERIFY_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    PIN_ALERT_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    PIN_AUTO_REPIN: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    POW_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    POW_DIFFICULTY: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    POW_CHALLENGE_TTL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    COMMITMENT_RATE_LIMIT: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    COMMITMENT_RATE_WINDOW_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    FLAG_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    FLAG_POW_DIFFICULTY: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_RENEWAL_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_RENEWAL_THRESHOLD_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_GRACE_PERIOD_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_BATCH_SIZE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    TTL_CHECK_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    TTL_COST_TRACKING_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    TTL_MAX_FEE: z.ZodDefault<z.ZodString>;
    TTL_SLIPPAGE_LEDGERS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    BACKUP_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    BACKUP_S3_BUCKET: z.ZodOptional<z.ZodString>;
    S3_BUCKET: z.ZodOptional<z.ZodString>;
    ARCHIVAL_AGE_DAYS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    ARCHIVAL_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_RPC_FAILURE_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_RPC_RESET_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_PINATA_FAILURE_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_PINATA_RESET_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_GATEWAY_FAILURE_THRESHOLD: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    CIRCUIT_BREAKER_GATEWAY_RESET_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_MONITOR_INTERVAL_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_LIMIT_MB: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_WARN_RATIO: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_CRITICAL_RATIO: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    MEMORY_AUTO_RESTART: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    MAX_CACHED_DAOS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    DB_QUERY_CACHE_MAX_ENTRIES: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    RELAYER_TEST_MODE: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
    LOG_SAMPLING_RATE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_SAMPLING_ERROR_RATE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_SAMPLING_SLOW_RATE: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_SLOW_THRESHOLD_MS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    LOG_BODY_MAX_CHARS: z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    HOT_RELOAD_ENABLED: z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined>;
}, z.ZodTypeAny, "passthrough">>;
export type RawConfig = z.infer<typeof configSchema>;
/**
 * Parse and validate environment variables against the schema.
 * Returns the validated config object and any warnings.
 */
export declare function validateConfig(env?: Record<string, string | undefined>): {
    config: ValidatedConfig;
    warnings: string[];
};
export interface ValidatedConfig {
    port: number;
    rpcUrl: string;
    rpcUrls: string[];
    networkPassphrase: string;
    rpcTimeoutMs: number;
    relayerAuthToken: string;
    relayerSecretKey: string | undefined;
    votingContractId: string;
    treeContractId: string;
    commentsContractId: string;
    daoRegistryContractId: string | undefined;
    membershipSbtContractId: string | undefined;
    bridgeContractId: string | undefined;
    circuitRegistryContractId: string | undefined;
    staticVkVersion: number | undefined;
    corsOrigins: readonly string[] | "*";
    logClientIp: "plain" | "hash" | undefined;
    logRequestBody: boolean;
    stripRequestBodies: boolean;
    genericErrors: boolean;
    healthExposeDetails: boolean;
    healthcheckPing: boolean;
    indexerEnabled: boolean;
    indexerPollIntervalMs: number;
    daoSyncIntervalMs: number;
    membershipSyncIntervalMs: number;
    pinataJwt: string | undefined;
    pinataGateway: string | undefined;
    ipfsEnabled: boolean;
    ipfsBackupDir: string;
    web3StorageToken: string | undefined;
    pinVerifyIntervalMs: number;
    pinAlertThreshold: number;
    pinAutoRepin: boolean;
    powEnabled: boolean;
    powDifficulty: number;
    powChallengeTtlMs: number;
    commitmentRateLimit: number;
    commitmentRateWindowMs: number;
    flagThreshold: number;
    flagPowDifficulty: number;
    ttlRenewalIntervalMs: number;
    ttlRenewalThresholdMs: number;
    ttlGracePeriodMs: number;
    ttlBatchSize: number;
    ttlCheckEnabled: boolean;
    ttlCostTrackingEnabled: boolean;
    ttlMaxFee: string;
    ttlSlippageLedgers: number;
    backupIntervalMs: number;
    s3Bucket: string | undefined;
    archivalAgeDays: number;
    archivalIntervalMs: number;
    circuitBreakerRpcFailureThreshold: number;
    circuitBreakerRpcResetMs: number;
    circuitBreakerPinataFailureThreshold: number;
    circuitBreakerPinataResetMs: number;
    circuitBreakerGatewayFailureThreshold: number;
    circuitBreakerGatewayResetMs: number;
    memoryMonitorIntervalMs: number;
    memoryLimitMb: number;
    memoryWarnRatio: number;
    memoryCriticalRatio: number;
    memoryAutoRestart: boolean;
    maxCachedDaos: number;
    dbQueryCacheMaxEntries: number;
    testMode: boolean;
    logSamplingRate: number;
    logSamplingErrorRate: number;
    logSamplingSlowRate: number;
    logSlowThresholdMs: number;
    logBodyMaxChars: number;
    hotReloadEnabled: boolean;
}
/**
 * Generate a .env.example file from the Zod schema.
 * Called via: npm run config:generate
 */
export declare function generateEnvExample(): string;
/**
 * Return a copy of the raw config with secret values masked.
 * Used for /config display and diagnostic logging.
 */
export declare function maskSecrets(env: Record<string, string | undefined>): Record<string, string | undefined>;
/** Snapshot of config for change detection */
export type ConfigSnapshot = Record<string, string | undefined>;
/**
 * Detect and report differences between two config snapshots.
 * Returns a list of changed variables with old → new values (secrets masked).
 */
export declare function detectConfigChanges(previous: ConfigSnapshot, current: ConfigSnapshot): Array<{
    key: string;
    old: string | undefined;
    new: string | undefined;
}>;
/**
 * Check if a config key is safe to hot-reload.
 */
export declare function isHotReloadable(key: string): boolean;
/**
 * Apply hot-reload changes to a config snapshot.
 * Returns a new snapshot with only hot-reloadable changes applied.
 */
export declare function applyHotReload(current: ConfigSnapshot, updates: ConfigSnapshot): ConfigSnapshot;
//# sourceMappingURL=config-schema.d.ts.map