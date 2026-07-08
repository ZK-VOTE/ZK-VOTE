/**
 * Environment Configuration
 *
 * Centralizes all environment variables and configuration.
 */
/**
 * Validate Stellar contract ID format
 */
export declare function isValidContractId(contractId: string | undefined): contractId is string;
export declare const config: {
    readonly port: number;
    readonly rpcUrl: string;
    readonly networkPassphrase: string;
    readonly rpcTimeoutMs: number;
    readonly relayerAuthToken: string | undefined;
    readonly relayerSecretKey: string | undefined;
    readonly votingContractId: string | undefined;
    readonly treeContractId: string | undefined;
    readonly commentsContractId: string | undefined;
    readonly daoRegistryContractId: string | undefined;
    readonly membershipSbtContractId: string | undefined;
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
 * Validate required environment variables
 * Throws if required vars are missing
 */
export declare function validateEnv(): void;
//# sourceMappingURL=config.d.ts.map