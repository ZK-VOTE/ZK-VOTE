/**
 * Environment Configuration
 *
 * Centralizes all environment variables and configuration.
 */

import dotenv from "dotenv";

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

  // Soroban RPC
  rpcUrl: process.env.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc",
  networkPassphrase:
    process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017",
  rpcTimeoutMs: Number(process.env.RPC_TIMEOUT_MS || 30_000),

  // Authentication
  relayerAuthToken: process.env.RELAYER_AUTH_TOKEN,
  relayerSecretKey: process.env.RELAYER_SECRET_KEY,

  // Contract IDs
  votingContractId: process.env.VOTING_CONTRACT_ID,
  treeContractId: process.env.TREE_CONTRACT_ID,
  commentsContractId: process.env.COMMENTS_CONTRACT_ID,
  daoRegistryContractId: process.env.DAO_REGISTRY_CONTRACT_ID,
  membershipSbtContractId: process.env.MEMBERSHIP_SBT_CONTRACT_ID,

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

  // IPFS/Pinata
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: process.env.PINATA_GATEWAY,
  ipfsEnabled: !!process.env.PINATA_JWT,

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
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
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
  if (!config.relayerAuthToken) missing.push("RELAYER_AUTH_TOKEN");

  if (missing.length > 0) {
    console.error(
      JSON.stringify({ level: "error", event: "missing_env", missing }),
    );
    console.error("\nRun ./scripts/init-local.sh to generate backend/.env");
    process.exit(1);
  }

  // Validate auth token strength (minimum 32 characters for security)
  // Skip validation in test mode since tests set short tokens for convenience
  if (
    config.relayerAuthToken &&
    config.relayerAuthToken.length < 32 &&
    !config.testMode
  ) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "weak_auth_token",
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
