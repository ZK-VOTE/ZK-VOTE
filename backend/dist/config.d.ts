/**
 * Environment Configuration
 *
 * Centralizes all environment variables and configuration.
 * Secrets can be retrieved dynamically via the SecretManager
 * for runtime fetch from Vault or Fly.io secrets.
 */
/**
 * Validate Stellar contract ID format
 */
export declare function isValidContractId(contractId: string | undefined): contractId is string;
export declare const config: {
    readonly NODE_ENV: "development" | "production" | "test";
    readonly port: number;
    readonly clusterEnabled: boolean;
    readonly clusterWorkers: number;
    readonly rpcUrl: string;
    readonly rpcUrls: string[];
    readonly networkPassphrase: string;
    readonly rpcTimeoutMs: number;
    readonly shutdownDrainTimeoutMs: number;
    readonly relayerAuthToken: string | undefined;
    readonly relayerSecretKey: string | undefined;
    readonly authMasterKey: string | undefined;
    readonly tokenRotationEnabled: boolean;
    readonly tokenRotationIntervalMs: number;
    readonly tokenRotationTransitionMs: number;
    readonly defaultTokenLifetimeMs: number;
    readonly tokenAuditLogEnabled: boolean;
    readonly votingContractId: string | undefined;
    readonly treeContractId: string | undefined;
    readonly commentsContractId: string | undefined;
    readonly daoRegistryContractId: string | undefined;
    readonly membershipSbtContractId: string | undefined;
    readonly bridgeContractId: string | undefined;
    readonly circuitRegistryContractId: string | undefined;
    readonly staticVkVersion: number | undefined;
    readonly corsOrigins: string[] | "*";
    readonly logClientIp: "plain" | "hash" | undefined;
    readonly logRequestBody: boolean;
    readonly stripRequestBodies: boolean;
    readonly genericErrors: boolean;
    readonly healthExposeDetails: boolean;
    readonly healthcheckPing: boolean;
    readonly indexerEnabled: boolean;
    readonly indexerPollIntervalMs: number;
    readonly daoSyncIntervalMs: number;
    readonly membershipSyncIntervalMs: number;
    readonly pinataJwt: string | undefined;
    readonly pinataGateway: string | undefined;
    readonly ipfsEnabled: boolean;
    readonly ipfsSubdomain: string | undefined;
    readonly ipfsBackupDir: string;
    readonly web3StorageToken: string | undefined;
    readonly pinVerifyIntervalMs: number;
    readonly pinAlertThreshold: number;
    readonly pinAutoRepin: boolean;
    readonly powEnabled: boolean;
    readonly powDifficulty: number;
    readonly powChallengeTtlMs: number;
    readonly commitmentRateLimit: number;
    readonly commitmentRateWindowMs: number;
    readonly flagThreshold: number;
    readonly flagPowDifficulty: number;
    readonly ttlRenewalIntervalMs: number;
    readonly ttlRenewalThresholdMs: number;
    readonly ttlGracePeriodMs: number;
    readonly ttlBatchSize: number;
    readonly ttlCheckEnabled: boolean;
    readonly ttlCostTrackingEnabled: boolean;
    readonly ttlMaxFee: string;
    readonly ttlSlippageLedgers: number;
    readonly sbtTransferWatchIntervalMs: number;
    readonly adminAlertWebhookUrl: string | undefined;
    readonly backupIntervalMs: number;
    readonly s3Bucket: string | undefined;
    readonly archivalAgeDays: number;
    readonly archivalIntervalMs: number;
    readonly auditLogRetentionDays: number;
    readonly auditLogRotationIntervalMs: number;
    readonly auditLogArchiveDir: string;
    readonly maxProofAgeSeconds: number;
    readonly requireClientCert: boolean;
    readonly walletRateLimitMax: number;
    readonly walletRateLimitWindowMs: number;
    readonly relayerPublicKey: string;
    readonly circuitBreakerRpcFailureThreshold: number;
    readonly circuitBreakerRpcResetMs: number;
    readonly circuitBreakerPinataFailureThreshold: number;
    readonly circuitBreakerPinataResetMs: number;
    readonly circuitBreakerGatewayFailureThreshold: number;
    readonly circuitBreakerGatewayResetMs: number;
    readonly memoryMonitorIntervalMs: number;
    readonly memoryLimitMb: number;
    readonly memoryWarnRatio: number;
    readonly memoryCriticalRatio: number;
    readonly memoryAutoRestart: boolean;
    readonly maxCachedDaos: number;
    readonly dbQueryCacheMaxEntries: number;
    readonly dbBusyTimeoutMs: number;
    readonly dbCheckpointIntervalMs: number;
    readonly dbCheckpointTransactionCount: number;
    readonly dbWalWarningThresholdBytes: number;
    readonly dbBackupIntervalMs: number;
    readonly dbRetryCount: number;
    readonly dbRetryBaseDelayMs: number;
    readonly dbRetryMaxDelayMs: number;
    readonly maxSequenceRetryAttempts: number;
    readonly voteSubmissionPendingTtlMs: number;
    readonly testMode: boolean;
};
export declare const LIMITS: {
    readonly MAX_IMAGE_SIZE: number;
    readonly MAX_METADATA_SIZE: number;
    readonly MAX_PROPOSAL_BODY: 100000;
    readonly MAX_COMMENT_BODY: 10000;
    readonly MAX_JSON_BODY: number;
    readonly IPFS_CACHE_TTL: number;
};
export declare const ALLOWED_IMAGE_MIMES: readonly ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/heic", "image/heif", "image/avif", "image/bmp", "image/tiff"];
export declare const BN254_MODULUS: bigint;
export declare const BN254_SCALAR_FIELD: bigint;
/**
 * Validate required environment variables and business logic constraints.
 * Zod validates structural/type constraints on module load; this function
 * validates business logic (required fields, contract ID format, key strength).
 * Throws if validation fails.
 */
export declare function validateEnv(): void;
//# sourceMappingURL=config.d.ts.map