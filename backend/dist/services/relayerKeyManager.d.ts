/**
 * Relayer Key Manager & Hot Key Rotation Service
 *
 * Implements multiple relayer key management (primary + secondary/standby),
 * zero-downtime hot key rotation without server restart, automatic low-balance
 * failover, key generation & funding automation, and key health monitoring.
 *
 * Issue #177: Implement Relayer Key Rotation Without Service Interruption
 */
import * as StellarSdk from "@stellar/stellar-sdk";
export type KeyRole = "primary" | "secondary" | "standby" | "deprecated";
export type KeyStatus = "active" | "standby" | "low_balance" | "exhausted" | "deprecated" | "revoked";
export type SignerType = "local" | "aws_kms" | "gcp_kms" | "pkcs11" | "test";
export interface StellarSigner {
    getPublicKey(): string;
    signTransaction(tx: StellarSdk.Transaction): Promise<void> | void;
    signHash?(hash: Buffer): Promise<Buffer> | Buffer;
}
export type RelayerKeypair = StellarSdk.Keypair | {
    publicKey: () => string;
};
export declare class LocalKeypairSigner implements StellarSigner {
    private keypair;
    constructor(keypair: StellarSdk.Keypair);
    getPublicKey(): string;
    signTransaction(tx: StellarSdk.Transaction): void;
    signHash(hash: Buffer): Buffer;
}
export declare class MockTestSigner implements StellarSigner {
    private pubKey;
    constructor(pubKey: string);
    getPublicKey(): string;
    signTransaction(_tx: StellarSdk.Transaction): void;
    signHash(_hash: Buffer): Buffer;
}
export declare class KmsSigner implements StellarSigner {
    private publicKey;
    private keyId;
    private region;
    constructor(publicKey: string, keyId: string, region?: string);
    getPublicKey(): string;
    signTransaction(tx: StellarSdk.Transaction): Promise<void>;
    signHash(hash: Buffer): Promise<Buffer>;
}
export declare class HsmSigner implements StellarSigner {
    private publicKey;
    private slotId;
    constructor(publicKey: string, slotId?: number);
    getPublicKey(): string;
    signTransaction(tx: StellarSdk.Transaction): Promise<void>;
    signHash(hash: Buffer): Promise<Buffer>;
}
export interface RelayerManagedKey {
    id: string;
    publicKey: string;
    role: KeyRole;
    status: KeyStatus;
    signerType: SignerType;
    signer: StellarSigner;
    keypair?: RelayerKeypair;
    secretKey?: string;
    balanceXlm: number | null;
    lastBalanceCheckAt: string | null;
    txCount: number;
    createdAt: string;
    activatedAt: string | null;
    lastUsedAt: string | null;
    lastRotatedAt: string | null;
    metadata?: Record<string, unknown>;
}
export interface RegisterKeyOptions {
    id?: string;
    secretKey?: string;
    publicKey?: string;
    signerType?: SignerType;
    kmsKeyId?: string;
    kmsRegion?: string;
    role?: KeyRole;
    makeActive?: boolean;
    metadata?: Record<string, unknown>;
}
export interface RelayerKeySummary {
    id: string;
    publicKey: string;
    role: KeyRole;
    status: KeyStatus;
    signerType: SignerType;
    balanceXlm: number | null;
    lastBalanceCheckAt: string | null;
    txCount: number;
    createdAt: string;
    activatedAt: string | null;
    ageDays: number;
    lastUsedAt: string | null;
    lastRotatedAt: string | null;
}
export interface RelayerKeyHealth {
    status: "healthy" | "degraded" | "critical";
    activeKey: RelayerKeySummary | null;
    secondaryKey: RelayerKeySummary | null;
    totalKeys: number;
    availableStandbyKeys: number;
    minBalanceThresholdXlm: number;
    autoRotateEnabled: boolean;
    keys: RelayerKeySummary[];
    alerts: string[];
}
export type RotationCallback = (newKey: RelayerManagedKey, oldKey: RelayerManagedKey | null, trigger: string) => Promise<void> | void;
export declare class RelayerKeyManager {
    private keys;
    private activeKeyId;
    private rotationListeners;
    private minBalanceThresholdXlm;
    private autoRotateEnabled;
    private initialized;
    constructor();
    /**
     * Initialize keys from environment configuration.
     */
    initialize(opts?: {
        secretKey?: string;
        secondarySecretKey?: string;
        publicKey?: string;
        secondaryPublicKey?: string;
        signerType?: SignerType;
        kmsKeyId?: string;
        kmsRegion?: string;
        testMode?: boolean;
    }): void;
    /**
     * Subscribe to key rotation events.
     */
    onRotate(callback: RotationCallback): () => void;
    /**
     * Get the active relayer managed key.
     */
    getActiveKey(): RelayerManagedKey | null;
    /**
     * Get the active StellarSigner instance.
     */
    getActiveSigner(): StellarSigner;
    /**
     * Get the active relayer keypair.
     */
    getActiveKeypair(): RelayerKeypair;
    /**
     * Get the active public key.
     */
    getPublicKey(): string;
    /**
     * Sign a transaction with the active signer and record usage.
     */
    signTransaction(tx: StellarSdk.Transaction): Promise<void>;
    /**
     * Register a new secondary / standby relayer key.
     */
    registerKey(options: RegisterKeyOptions): RelayerManagedKey;
    /**
     * Generate a fresh Stellar keypair and register it as a secondary key.
     */
    generateKey(role?: KeyRole, makeActive?: boolean): RelayerManagedKey;
    /**
     * Rotate active key to a target key, or swap to the best available secondary key.
     * Zero downtime hot-swap without restarting the process.
     */
    rotateActiveKey(targetKeyIdOrPublicKey?: string, trigger?: "manual" | "low_balance" | "api" | "scheduled"): Promise<{
        success: boolean;
        activeKey: RelayerKeySummary;
        previousKey: RelayerKeySummary | null;
    }>;
    /**
     * Check balance for a specific key using Soroban/Stellar RPC.
     */
    checkBalance(keyIdOrPublicKey?: string, rpcServer?: StellarSdk.rpc.Server | {
        getAccount: (pk: string) => Promise<unknown>;
    }): Promise<number>;
    /**
     * Check balances for all managed keys and detect low balances.
     */
    checkAllBalances(rpcServer?: StellarSdk.rpc.Server | {
        getAccount: (pk: string) => Promise<unknown>;
    }): Promise<Record<string, number | null>>;
    /**
     * Low balance automated failover check.
     * If active primary key falls below threshold, automatically rotates to secondary.
     */
    checkAndHandleLowBalance(minBalanceXlm?: number, rpcServer?: StellarSdk.rpc.Server | {
        getAccount: (pk: string) => Promise<unknown>;
    }): Promise<{
        rotated: boolean;
        activePublicKey: string;
        balanceXlm: number | null;
    }>;
    /**
     * Automate funding for a relayer account.
     * In testnet/futurenet/local, uses Friendbot.
     */
    fundKey(publicKey: string, friendbotUrl?: string): Promise<{
        success: boolean;
        message: string;
    }>;
    /**
     * Get health status & summary of relayer keys for diagnostic / health endpoints.
     */
    getKeyHealth(): RelayerKeyHealth;
    /**
     * List all managed relayer keys.
     */
    getAllKeys(): RelayerKeySummary[];
    /**
     * Set balance threshold in XLM for alerts & failover.
     */
    setMinBalanceThreshold(thresholdXlm: number): void;
    /**
     * Enable or disable auto rotation on low balance.
     */
    setAutoRotateEnabled(enabled: boolean): void;
    /**
     * Helper to summarize key metadata without leaking secrets.
     */
    private summarizeKey;
    private notifyRotation;
    private updateMetrics;
    /**
     * Reset manager state (for testing).
     */
    reset(): void;
}
export declare const relayerKeyManager: RelayerKeyManager;
//# sourceMappingURL=relayerKeyManager.d.ts.map