// @ts-nocheck
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
import crypto from "crypto";
import { config } from "../config.js";
import { createLogger } from "./logger.js";
import {
  relayerKeyBalance,
  relayerKeyRotationsTotal,
  relayerKeyAgeSeconds,
  relayerKeyTransactionsTotal,
  relayerSigningRefusedTotal,
  relayerSigningTierTotal,
  relayerActiveKeyAgeSeconds,
  relayerFundedStandbyKeys,
  relayerDrainingKeys,
} from "./metrics.js";
import {
  SigningPolicy,
  SigningRefusedError,
  type SignAuthorization,
} from "./relayer-signing-policy.js";

const logger = createLogger("relayer-key-manager");

// ============================================
// TYPES
// ============================================

export type KeyRole = "primary" | "secondary" | "standby" | "deprecated";
export type KeyStatus =
  | "active"
  | "standby"
  | "low_balance"
  | "exhausted"
  | "deprecated"
  // Previous identity inside the dual-identity window: may still sign
  // transactions sourced from its own account until drainUntil (#746).
  | "draining"
  | "revoked"
  // Declared compromised: never signs again except a compromise sweep.
  | "compromised";

/** Statuses that may never become active or sign normal transactions. */
const REVOKED_STATUSES: ReadonlySet<KeyStatus> = new Set(["revoked", "compromised"]);

export type SignerType = "local" | "aws_kms" | "gcp_kms" | "pkcs11" | "test";

export interface StellarSigner {
  getPublicKey(): string;
  signTransaction(tx: StellarSdk.Transaction): Promise<void> | void;
  signHash?(hash: Buffer): Promise<Buffer> | Buffer;
}

export type RelayerKeypair = StellarSdk.Keypair | { publicKey: () => string };

export class LocalKeypairSigner implements StellarSigner {
  constructor(private keypair: StellarSdk.Keypair) {}
  getPublicKey(): string {
    return this.keypair.publicKey();
  }
  signTransaction(tx: StellarSdk.Transaction): void {
    tx.sign(this.keypair);
  }
  signHash(hash: Buffer): Buffer {
    return this.keypair.sign(hash);
  }
}

export class MockTestSigner implements StellarSigner {
  constructor(private pubKey: string) {}
  getPublicKey(): string {
    return this.pubKey;
  }
  signTransaction(_tx: StellarSdk.Transaction): void {}
  signHash(_hash: Buffer): Buffer {
    return Buffer.alloc(64);
  }
}

export class KmsSigner implements StellarSigner {
  private publicKey: string;
  private keyId: string;
  private region: string;

  constructor(publicKey: string, keyId: string, region = "us-east-1") {
    this.publicKey = publicKey;
    this.keyId = keyId;
    this.region = region;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async signTransaction(tx: StellarSdk.Transaction): Promise<void> {
    const txHash = tx.hash();
    const signature = await this.signHash(txHash);
    const rawPublicKey = StellarSdk.StrKey.decodeEd25519PublicKey(this.publicKey);
    const hint = rawPublicKey.subarray(rawPublicKey.length - 4);
    const decoratedSig = new StellarSdk.xdr.DecoratedSignature({
      hint,
      signature,
    });
    tx.signatures.push(decoratedSig);
  }

  async signHash(hash: Buffer): Promise<Buffer> {
    logger.error("kms_sign_not_implemented", {
      keyId: this.keyId,
      region: this.region,
      hashLength: hash.length,
    });
    throw new Error(
      `KMS signing not implemented: integrate with AWS KMS SDK for key ${this.keyId} in ${this.region}. ` +
      `Refusing to return dummy signature.`
    );
  }
}

export class HsmSigner implements StellarSigner {
  private publicKey: string;
  private slotId: number;

  constructor(publicKey: string, slotId = 0) {
    this.publicKey = publicKey;
    this.slotId = slotId;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async signTransaction(tx: StellarSdk.Transaction): Promise<void> {
    const txHash = tx.hash();
    const signature = await this.signHash(txHash);
    const rawPublicKey = StellarSdk.StrKey.decodeEd25519PublicKey(this.publicKey);
    const hint = rawPublicKey.subarray(rawPublicKey.length - 4);
    const decoratedSig = new StellarSdk.xdr.DecoratedSignature({
      hint,
      signature,
    });
    tx.signatures.push(decoratedSig);
  }

  async signHash(hash: Buffer): Promise<Buffer> {
    logger.error("hsm_sign_not_implemented", {
      slotId: this.slotId,
      hashLength: hash.length,
    });
    throw new Error(
      `HSM PKCS#11 signing not implemented: integrate with PKCS#11 module for slot ${this.slotId}. ` +
      `Refusing to return dummy signature.`
    );
  }
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
  /** End of this key's drain window (epoch ms) while status is "draining". */
  drainUntil?: number | null;
  revokedReason?: string | null;
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
  drainUntil: string | null;
  revokedReason: string | null;
}

/** A signature produced by a managed key that may not have landed yet. */
export interface OutstandingSignature {
  hash: string;
  publicKey: string;
  signedAt: number;
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

/**
 * The account whose sequence number and authority a transaction uses: the
 * fee source for a fee bump, else the transaction source (muxed → base G...).
 */
export function transactionSourceAccount(tx: any): string | null {
  const raw: string | undefined = tx?.feeSource ?? tx?.source;
  if (!raw) return null;
  if (raw.startsWith("M")) {
    try {
      return (StellarSdk as any).extractBaseAddress(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export type RotationCallback = (
  newKey: RelayerManagedKey,
  oldKey: RelayerManagedKey | null,
  trigger: string,
) => Promise<void> | void;

// ============================================
// RELAYER KEY MANAGER CLASS
// ============================================

export class RelayerKeyManager {
  private keys: Map<string, RelayerManagedKey> = new Map();
  private activeKeyId: string | null = null;
  private rotationListeners: Set<RotationCallback> = new Set();
  private minBalanceThresholdXlm: number = 5;
  private autoRotateEnabled: boolean = true;
  private initialized = false;
  private signingPolicy: SigningPolicy | null = null;
  private drainWindowMs: number;
  /** Public keys revoked in a previous process lifetime (persisted store). */
  private persistedRevocations: Map<string, string> = new Map();
  /** Recent signatures per key, so a compromise can report what it invalidates. */
  private outstanding: Map<string, OutstandingSignature> = new Map();
  private static readonly MAX_OUTSTANDING = 5_000;
  private static readonly OUTSTANDING_TTL_MS = 10 * 60 * 1000;

  constructor() {
    this.minBalanceThresholdXlm = config.relayerMinBalanceXlm ?? 5;
    this.autoRotateEnabled = config.relayerAutoRotateLowBalance ?? true;
    this.drainWindowMs = config.relayerRotationDrainWindowMs ?? 5 * 60 * 1000;
  }

  /** Install the tier/halt policy every signature must pass (#746). */
  public setSigningPolicy(policy: SigningPolicy | null): void {
    this.signingPolicy = policy;
  }

  public getSigningPolicy(): SigningPolicy | null {
    return this.signingPolicy;
  }

  public setDrainWindowMs(ms: number): void {
    this.drainWindowMs = ms;
  }

  /**
   * Initialize keys from environment configuration.
   */
  public initialize(opts?: {
    secretKey?: string;
    secondarySecretKey?: string;
    publicKey?: string;
    secondaryPublicKey?: string;
    signerType?: SignerType;
    kmsKeyId?: string;
    kmsRegion?: string;
    testMode?: boolean;
  }): void {
    const isTestMode = opts?.testMode ?? config.testMode;
    const primarySecret = opts?.secretKey ?? config.relayerSecretKey;
    const secondarySecret =
      opts?.secondarySecretKey ?? config.relayerSecondarySecretKey;
    const signerType =
      opts?.signerType ?? (config.relayerSignerType as SignerType) ?? "local";

    this.keys.clear();
    this.activeKeyId = null;

    if (isTestMode) {
      const testPubKey =
        opts?.publicKey ||
        (config.relayerPublicKey && config.relayerPublicKey.length > 0
          ? config.relayerPublicKey
          : undefined) ||
        "GTESTRELAYERADDRESS000000000000000000000000000000000000";
      const primaryKey: RelayerManagedKey = {
        id: "relayer-primary-test",
        publicKey: testPubKey,
        role: "primary",
        status: "active",
        signerType: "test",
        signer: new MockTestSigner(testPubKey),
        keypair: { publicKey: () => testPubKey },
        balanceXlm: 1000,
        lastBalanceCheckAt: new Date().toISOString(),
        txCount: 0,
        createdAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
        lastUsedAt: null,
        lastRotatedAt: null,
      };
      this.keys.set(primaryKey.id, primaryKey);
      this.activeKeyId = primaryKey.id;

      // Optional secondary test key
      const secondaryPubKey =
        opts?.secondaryPublicKey ||
        (config.relayerSecondaryPublicKey &&
        config.relayerSecondaryPublicKey.length > 0
          ? config.relayerSecondaryPublicKey
          : undefined) ||
        "GTESTRELAYERSECONDARY00000000000000000000000000000000000";
      const secondaryKey: RelayerManagedKey = {
        id: "relayer-secondary-test",
        publicKey: secondaryPubKey,
        role: "secondary",
        status: "standby",
        signerType: "test",
        signer: new MockTestSigner(secondaryPubKey),
        keypair: { publicKey: () => secondaryPubKey },
        balanceXlm: 1000,
        lastBalanceCheckAt: new Date().toISOString(),
        txCount: 0,
        createdAt: new Date().toISOString(),
        activatedAt: null,
        lastUsedAt: null,
        lastRotatedAt: null,
      };
      this.keys.set(secondaryKey.id, secondaryKey);
    } else if (signerType === "aws_kms" && (opts?.kmsKeyId || config.kmsKeyId)) {
      const pubKey = opts?.publicKey || config.relayerPublicKey;
      if (!pubKey) {
        throw new Error("RELAYER_PUBLIC_KEY is required for KMS signer");
      }
      const keyId = opts?.kmsKeyId || config.kmsKeyId!;
      const region = opts?.kmsRegion || config.kmsRegion || "us-east-1";
      const signer = new KmsSigner(pubKey, keyId, region);

      const primaryKey: RelayerManagedKey = {
        id: `kms-${keyId.slice(-8)}`,
        publicKey: pubKey,
        role: "primary",
        status: "active",
        signerType: "aws_kms",
        signer,
        keypair: { publicKey: () => pubKey },
        balanceXlm: null,
        lastBalanceCheckAt: null,
        txCount: 0,
        createdAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
        lastUsedAt: null,
        lastRotatedAt: null,
      };
      this.keys.set(primaryKey.id, primaryKey);
      this.activeKeyId = primaryKey.id;
    } else {
      if (!primarySecret) {
        throw new Error("RELAYER_SECRET_KEY is not set");
      }
      const primaryKp = StellarSdk.Keypair.fromSecret(primarySecret);
      const primaryPubKey = primaryKp.publicKey();
      const primaryKey: RelayerManagedKey = {
        id: "relayer-primary",
        publicKey: primaryPubKey,
        role: "primary",
        status: "active",
        signerType: "local",
        signer: new LocalKeypairSigner(primaryKp),
        keypair: primaryKp,
        secretKey: primarySecret,
        balanceXlm: null,
        lastBalanceCheckAt: null,
        txCount: 0,
        createdAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
        lastUsedAt: null,
        lastRotatedAt: null,
      };
      this.keys.set(primaryKey.id, primaryKey);
      this.activeKeyId = primaryKey.id;

      if (secondarySecret) {
        try {
          const secKp = StellarSdk.Keypair.fromSecret(secondarySecret);
          const secPubKey = secKp.publicKey();
          const secondaryKey: RelayerManagedKey = {
            id: "relayer-secondary",
            publicKey: secPubKey,
            role: "secondary",
            status: "standby",
            signerType: "local",
            signer: new LocalKeypairSigner(secKp),
            keypair: secKp,
            secretKey: secondarySecret,
            balanceXlm: null,
            lastBalanceCheckAt: null,
            txCount: 0,
            createdAt: new Date().toISOString(),
            activatedAt: null,
            lastUsedAt: null,
            lastRotatedAt: null,
          };
          this.keys.set(secondaryKey.id, secondaryKey);
        } catch (err) {
          logger.warn("invalid_secondary_relayer_key", {
            error: (err as Error).message,
          });
        }
      }
    }

    this.updateMetrics();
    this.initialized = true;
    logger.info("relayer_key_manager_initialized", {
      activeKey: this.getActiveKey()?.publicKey,
      totalKeys: this.keys.size,
    });
  }

  /**
   * Subscribe to key rotation events.
   */
  public onRotate(callback: RotationCallback): () => void {
    this.rotationListeners.add(callback);
    return () => this.rotationListeners.delete(callback);
  }

  /**
   * Get the active relayer managed key.
   */
  public getActiveKey(): RelayerManagedKey | null {
    if (!this.activeKeyId) return null;
    return this.keys.get(this.activeKeyId) || null;
  }

  /**
   * Get the active StellarSigner instance.
   */
  public getActiveSigner(): StellarSigner {
    const active = this.getActiveKey();
    if (!active) {
      throw new Error("No active relayer key configured");
    }
    return active.signer;
  }

  /**
   * Get the active relayer keypair.
   */
  public getActiveKeypair(): RelayerKeypair {
    const active = this.getActiveKey();
    if (!active) {
      throw new Error("No active relayer key configured");
    }
    return active.keypair || { publicKey: () => active.publicKey };
  }

  /**
   * Get the active public key.
   */
  public getPublicKey(): string {
    const active = this.getActiveKey();
    return active ? active.publicKey : "";
  }

  /**
   * Sign a transaction with the key that owns its source account (#746).
   *
   * A Stellar relayer key is an account with its own sequence chain, so a
   * transaction built against the old account must be signed by the old key
   * even if a rotation happened between build and sign. Signing it with the
   * newly active key (the previous behaviour) produced tx_bad_auth for every
   * in-flight item at cutover. Rules:
   *
   *  - source is the active key            → sign
   *  - source is a draining key            → sign until its drain window ends
   *  - source is revoked / compromised     → refuse (sweep purpose excepted)
   *  - source is an idle standby key       → refuse (it has no in-flight work)
   *  - source is not a managed key         → the relayer is a co-signer on
   *                                          someone else's tx: active key signs
   *
   * Every signature also passes the tier/halt policy when one is installed.
   */
  public async signTransaction(
    tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
    auth: SignAuthorization = {},
  ): Promise<void> {
    const key = this.resolveSigningKey(tx, auth);
    if (auth.purpose === "sweep" && !this.signingPolicy) {
      // The policy is what pins a sweep to the safe account; without it a
      // sweep purpose would be an unchecked way to sign with a revoked key.
      this.refuse("sweep_unauthorized", "Sweep signing requires an installed signing policy");
    }
    try {
      const classification = this.signingPolicy?.authorize(tx, auth);
      if (classification) {
        relayerSigningTierTotal.inc({ tier: classification.tier });
      }
    } catch (err) {
      if (err instanceof SigningRefusedError) {
        relayerSigningRefusedTotal.inc({ reason: err.reason });
      }
      throw err;
    }

    await key.signer.signTransaction(tx as StellarSdk.Transaction);
    key.txCount++;
    key.lastUsedAt = new Date().toISOString();
    this.recordOutstanding(tx, key.publicKey);
    relayerKeyTransactionsTotal.inc({ key_id: key.id });
  }

  private refuse(reason: string, message: string): never {
    relayerSigningRefusedTotal.inc({ reason });
    throw new SigningRefusedError(reason, message);
  }

  private resolveSigningKey(
    tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
    auth: SignAuthorization,
  ): RelayerManagedKey {
    const source = transactionSourceAccount(tx);
    const owner = source
      ? Array.from(this.keys.values()).find((k) => k.publicKey === source)
      : undefined;

    // A sweep exists only to empty a compromised account; on any other
    // identity the purpose would be a way around the tier gate.
    if (auth.purpose === "sweep" && owner?.status !== "compromised") {
      this.refuse("sweep_unauthorized", "Sweep signing is only allowed for a compromised relayer account");
    }

    if (!owner) {
      const active = this.getActiveKey();
      if (!active) {
        this.refuse("no_active_key", "No active relayer signer available");
      }
      return active;
    }

    if (REVOKED_STATUSES.has(owner.status)) {
      if (auth.purpose === "sweep" && owner.status === "compromised") return owner;
      this.refuse(
        "identity_revoked",
        `Relayer key ${owner.id} is ${owner.status}; refusing to sign for ${owner.publicKey}`,
      );
    }
    if (owner.id === this.activeKeyId) return owner;
    if (owner.status === "draining") {
      if ((owner.drainUntil ?? 0) > Date.now()) return owner;
      this.finishDrain(owner.id);
      this.refuse(
        "drain_window_closed",
        `Drain window for relayer key ${owner.id} has closed; rebuild the transaction under the active identity`,
      );
    }
    this.refuse(
      "identity_inactive",
      `Relayer key ${owner.id} is ${owner.status}, not active; rebuild under the active identity`,
    );
  }

  private recordOutstanding(
    tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
    publicKey: string,
  ): void {
    const now = Date.now();
    const hash = tx.hash().toString("hex");
    this.outstanding.set(hash, { hash, publicKey, signedAt: now });
    // Insertion order is age order: drop expired or excess entries from the front.
    for (const [h, sig] of this.outstanding) {
      const expired = now - sig.signedAt >= RelayerKeyManager.OUTSTANDING_TTL_MS;
      if (!expired && this.outstanding.size <= RelayerKeyManager.MAX_OUTSTANDING) break;
      this.outstanding.delete(h);
    }
  }

  /** Recent signatures by `publicKey` that may still be in flight. */
  public getOutstandingSignatures(publicKey: string): OutstandingSignature[] {
    const cutoff = Date.now() - RelayerKeyManager.OUTSTANDING_TTL_MS;
    return Array.from(this.outstanding.values()).filter(
      (s) => s.publicKey === publicKey && s.signedAt >= cutoff,
    );
  }

  /** Close a key's drain window: it returns to idle standby. */
  public finishDrain(keyId: string): void {
    const key = this.keys.get(keyId);
    if (!key || key.status !== "draining") return;
    key.status = "standby";
    key.drainUntil = null;
    logger.info("relayer_key_drain_finished", { keyId, publicKey: key.publicKey });
    this.updateMetrics();
  }

  /** Close every drain window whose deadline has passed. Returns closed ids. */
  public expireDrains(now = Date.now()): string[] {
    const closed: string[] = [];
    for (const key of this.keys.values()) {
      if (key.status === "draining" && (key.drainUntil ?? 0) <= now) {
        this.finishDrain(key.id);
        closed.push(key.id);
      }
    }
    return closed;
  }

  /**
   * Revoke a key immediately. Signing for its account stops at once (sweep
   * excepted for "compromised"); it can never be made active again. Does not
   * choose a successor — the rotation orchestrator does that.
   */
  public revokeKey(
    keyIdOrPublicKey: string,
    reason: string,
    status: "revoked" | "compromised" = "compromised",
  ): RelayerManagedKey {
    const key = this.findKey(keyIdOrPublicKey);
    if (!key) throw new Error(`Relayer key ${keyIdOrPublicKey} not found`);
    key.status = status;
    key.role = "deprecated";
    key.drainUntil = null;
    key.revokedReason = reason;
    if (this.activeKeyId === key.id) this.activeKeyId = null;
    logger.warn("relayer_key_revoked", { keyId: key.id, publicKey: key.publicKey, status, reason });
    this.updateMetrics();
    return key;
  }

  /**
   * Apply revocations persisted by a previous process. A compromised secret
   * that is still in RELAYER_SECRET_KEY must not come back as the active key
   * after a restart: it is revoked and the best standby takes over, or — with
   * no standby — nothing is active and signing fails closed.
   */
  public applyPersistedRevocations(revoked: Map<string, string>): string[] {
    this.persistedRevocations = new Map(revoked);
    const applied: string[] = [];
    for (const key of this.keys.values()) {
      const reason = revoked.get(key.publicKey);
      if (reason !== undefined && !REVOKED_STATUSES.has(key.status)) {
        this.revokeKey(key.id, reason, "compromised");
        applied.push(key.id);
      }
    }
    if (applied.length > 0 && !this.activeKeyId) {
      const successor = this.bestStandby();
      if (successor) {
        successor.role = "primary";
        successor.status = "active";
        successor.activatedAt = new Date().toISOString();
        this.activeKeyId = successor.id;
        logger.warn("relayer_revoked_key_replaced_on_boot", { activeKeyId: successor.id });
      } else {
        logger.error("relayer_no_unrevoked_key_on_boot", { revoked: applied });
      }
    }
    this.updateMetrics();
    return applied;
  }

  public isPubliclyRevoked(publicKey: string): boolean {
    return this.persistedRevocations.has(publicKey);
  }

  public findKey(keyIdOrPublicKey: string): RelayerManagedKey | undefined {
    return (
      this.keys.get(keyIdOrPublicKey) ||
      Array.from(this.keys.values()).find((k) => k.publicKey === keyIdOrPublicKey)
    );
  }

  /** Standby keys that could take over, best balance first. */
  public standbyCandidates(): RelayerManagedKey[] {
    return Array.from(this.keys.values())
      .filter(
        (k) =>
          k.id !== this.activeKeyId &&
          !REVOKED_STATUSES.has(k.status) &&
          k.status !== "deprecated" &&
          k.status !== "exhausted" &&
          k.status !== "draining" &&
          !this.persistedRevocations.has(k.publicKey),
      )
      .sort((a, b) => (b.balanceXlm ?? 0) - (a.balanceXlm ?? 0));
  }

  private bestStandby(): RelayerManagedKey | undefined {
    return this.standbyCandidates()[0];
  }

  /**
   * Register a new secondary / standby relayer key.
   */
  public registerKey(options: RegisterKeyOptions): RelayerManagedKey {
    const id = options.id || `key-${crypto.randomBytes(4).toString("hex")}`;
    if (this.keys.has(id)) {
      throw new Error(`Relayer key with ID ${id} already exists`);
    }

    let signer: StellarSigner;
    let keypair: RelayerKeypair | undefined;
    let publicKey = options.publicKey || "";

    const signerType = options.signerType || "local";

    if (options.secretKey) {
      const kp = StellarSdk.Keypair.fromSecret(options.secretKey);
      publicKey = kp.publicKey();
      signer = new LocalKeypairSigner(kp);
      keypair = kp;
    } else if (signerType === "aws_kms") {
      if (!options.kmsKeyId || !options.publicKey) {
        throw new Error("kmsKeyId and publicKey are required for aws_kms");
      }
      publicKey = options.publicKey;
      signer = new KmsSigner(
        publicKey,
        options.kmsKeyId,
        options.kmsRegion || "us-east-1",
      );
      keypair = { publicKey: () => publicKey };
    } else if (signerType === "test" || config.testMode) {
      publicKey =
        options.publicKey ||
        `GTEST${crypto.randomBytes(24).toString("hex").toUpperCase()}`;
      signer = new MockTestSigner(publicKey);
      keypair = { publicKey: () => publicKey };
    } else {
      throw new Error("secretKey is required for local signer");
    }

    // Re-registering a revoked identity (e.g. the compromised secret pasted
    // back in) must not resurrect it.
    if (
      this.persistedRevocations.has(publicKey) ||
      Array.from(this.keys.values()).some(
        (k) => k.publicKey === publicKey && REVOKED_STATUSES.has(k.status),
      )
    ) {
      throw new Error(`Relayer key ${publicKey} is revoked and cannot be registered`);
    }

    const role: KeyRole = options.role || "secondary";
    const status: KeyStatus = options.makeActive ? "active" : "standby";

    const newKey: RelayerManagedKey = {
      id,
      publicKey,
      role,
      status,
      signerType,
      signer,
      keypair,
      secretKey: options.secretKey,
      balanceXlm: null,
      lastBalanceCheckAt: null,
      txCount: 0,
      createdAt: new Date().toISOString(),
      activatedAt: options.makeActive ? new Date().toISOString() : null,
      lastUsedAt: null,
      lastRotatedAt: null,
      metadata: options.metadata,
    };

    this.keys.set(id, newKey);

    if (options.makeActive) {
      const oldActive = this.getActiveKey();
      if (oldActive && oldActive.id !== id) {
        oldActive.role = "secondary";
        if (this.drainWindowMs > 0) {
          oldActive.status = "draining";
          oldActive.drainUntil = Date.now() + this.drainWindowMs;
        } else {
          oldActive.status = "standby";
        }
      }
      this.activeKeyId = id;
      this.notifyRotation(newKey, oldActive, "register_active");
    }

    this.updateMetrics();
    logger.info("relayer_key_registered", {
      keyId: id,
      publicKey,
      role,
      status,
      makeActive: options.makeActive,
    });

    return newKey;
  }

  /**
   * Generate a fresh Stellar keypair and register it as a secondary key.
   */
  public generateKey(
    role: KeyRole = "secondary",
    makeActive = false,
  ): RelayerManagedKey {
    if (config.testMode) {
      const id = `test-gen-${crypto.randomBytes(4).toString("hex")}`;
      const pub = `GTEST${crypto.randomBytes(24).toString("hex").toUpperCase()}`;
      return this.registerKey({
        id,
        publicKey: pub,
        signerType: "test",
        role,
        makeActive,
      });
    }

    const kp = StellarSdk.Keypair.random();
    const id = `gen-${kp.publicKey().slice(0, 8)}`;
    return this.registerKey({
      id,
      secretKey: kp.secret(),
      publicKey: kp.publicKey(),
      signerType: "local",
      role,
      makeActive,
    });
  }

  /**
   * Rotate active key to a target key, or swap to the best available secondary key.
   * Zero downtime hot-swap without restarting the process.
   */
  public async rotateActiveKey(
    targetKeyIdOrPublicKey?: string,
    trigger:
      | "manual"
      | "low_balance"
      | "api"
      | "scheduled"
      | "planned"
      | "compromise"
      | "rollback" = "manual",
    options: { drainPrevious?: boolean } = {},
  ): Promise<{ success: boolean; activeKey: RelayerKeySummary; previousKey: RelayerKeySummary | null }> {
    const previousActive = this.getActiveKey();
    let targetKey: RelayerManagedKey | undefined;

    if (targetKeyIdOrPublicKey) {
      targetKey = this.findKey(targetKeyIdOrPublicKey);
      if (!targetKey) {
        relayerKeyRotationsTotal.inc({ trigger, status: "failure" });
        throw new Error(
          `Target relayer key ${targetKeyIdOrPublicKey} not found`,
        );
      }
      // A revoked identity must never be reactivated, explicitly or not.
      if (
        REVOKED_STATUSES.has(targetKey.status) ||
        this.persistedRevocations.has(targetKey.publicKey)
      ) {
        relayerKeyRotationsTotal.inc({ trigger, status: "failure" });
        throw new Error(
          `Target relayer key ${targetKey.id} is revoked and cannot be activated`,
        );
      }
    } else {
      targetKey = this.bestStandby();
      if (!targetKey) {
        relayerKeyRotationsTotal.inc({ trigger, status: "failure" });
        throw new Error(
          "No available secondary/standby relayer keys to rotate to",
        );
      }
    }

    if (previousActive && previousActive.id === targetKey.id) {
      return {
        success: true,
        activeKey: this.summarizeKey(targetKey),
        previousKey: this.summarizeKey(previousActive),
      };
    }

    const now = new Date().toISOString();

    // Demote current active key. By default it enters a bounded drain window
    // (dual-identity window) so transactions already built against its
    // account can still be signed; new work goes to the new identity.
    if (previousActive) {
      const drain = options.drainPrevious ?? true;
      previousActive.role = "secondary";
      previousActive.lastRotatedAt = now;
      if (drain && this.drainWindowMs > 0) {
        previousActive.status = "draining";
        previousActive.drainUntil = Date.now() + this.drainWindowMs;
      } else {
        previousActive.status =
          previousActive.status === "low_balance" ? "low_balance" : "standby";
        previousActive.drainUntil = null;
      }
    }

    // Promote new active key (a draining key coming back ends its drain)
    targetKey.role = "primary";
    targetKey.status = "active";
    targetKey.drainUntil = null;
    targetKey.activatedAt = now;
    targetKey.lastRotatedAt = now;
    this.activeKeyId = targetKey.id;

    relayerKeyRotationsTotal.inc({ trigger, status: "success" });
    logger.info("relayer_key_rotated", {
      trigger,
      newActiveKeyId: targetKey.id,
      newActivePublicKey: targetKey.publicKey,
      previousKeyId: previousActive?.id,
      previousPublicKey: previousActive?.publicKey,
    });

    await this.notifyRotation(targetKey, previousActive, trigger);
    this.updateMetrics();

    return {
      success: true,
      activeKey: this.summarizeKey(targetKey),
      previousKey: previousActive ? this.summarizeKey(previousActive) : null,
    };
  }

  /**
   * Check balance for a specific key using Soroban/Stellar RPC.
   */
  public async checkBalance(
    keyIdOrPublicKey?: string,
    rpcServer?: StellarSdk.rpc.Server | { getAccount: (pk: string) => Promise<unknown> },
  ): Promise<number> {
    const key = keyIdOrPublicKey
      ? this.keys.get(keyIdOrPublicKey) ||
        Array.from(this.keys.values()).find(
          (k) => k.publicKey === keyIdOrPublicKey,
        )
      : this.getActiveKey();

    if (!key) {
      throw new Error(`Key ${keyIdOrPublicKey || "active"} not found`);
    }

    if (config.testMode || key.signerType === "test") {
      const bal = key.balanceXlm ?? 1000;
      key.balanceXlm = bal;
      key.lastBalanceCheckAt = new Date().toISOString();
      this.updateMetrics();
      return bal;
    }

    if (!rpcServer) {
      return key.balanceXlm ?? 0;
    }

    try {
      const account = (await rpcServer.getAccount(key.publicKey)) as any;
      // Extract native XLM balance from account object
      let xlmBalance = 0;
      if (account?.balances && Array.isArray(account.balances)) {
        const native = account.balances.find(
          (b: any) => b.asset_type === "native",
        );
        if (native?.balance) {
          xlmBalance = parseFloat(native.balance);
        }
      } else if (typeof account?.sequenceNumber === "function") {
        // Mocked or minimal account response, assume nominal balance if accessible
        xlmBalance = key.balanceXlm ?? 100;
      }

      key.balanceXlm = xlmBalance;
      key.lastBalanceCheckAt = new Date().toISOString();

      if (xlmBalance < this.minBalanceThresholdXlm) {
        if (key.status === "active") {
          key.status = "low_balance";
        }
      } else if (key.status === "low_balance") {
        key.status = key.role === "primary" ? "active" : "standby";
      }

      this.updateMetrics();
      return xlmBalance;
    } catch (err) {
      logger.warn("relayer_balance_check_failed", {
        publicKey: key.publicKey,
        error: (err as Error).message,
      });
      return key.balanceXlm ?? 0;
    }
  }

  /**
   * Check balances for all managed keys and detect low balances.
   */
  public async checkAllBalances(
    rpcServer?: StellarSdk.rpc.Server | { getAccount: (pk: string) => Promise<unknown> },
  ): Promise<Record<string, number | null>> {
    const balances: Record<string, number | null> = {};
    for (const key of this.keys.values()) {
      try {
        const bal = await this.checkBalance(key.id, rpcServer);
        balances[key.publicKey] = bal;
      } catch {
        balances[key.publicKey] = key.balanceXlm;
      }
    }
    return balances;
  }

  /**
   * Low balance automated failover check.
   * If active primary key falls below threshold, automatically rotates to secondary.
   */
  public async checkAndHandleLowBalance(
    minBalanceXlm = this.minBalanceThresholdXlm,
    rpcServer?: StellarSdk.rpc.Server | { getAccount: (pk: string) => Promise<unknown> },
  ): Promise<{ rotated: boolean; activePublicKey: string; balanceXlm: number | null }> {
    const active = this.getActiveKey();
    if (!active) {
      return { rotated: false, activePublicKey: "", balanceXlm: null };
    }

    if (rpcServer) {
      await this.checkBalance(active.id, rpcServer);
    }

    const currentBalance = active.balanceXlm;
    if (
      currentBalance !== null &&
      currentBalance < minBalanceXlm &&
      this.autoRotateEnabled
    ) {
      logger.warn("relayer_low_balance_detected", {
        publicKey: active.publicKey,
        balanceXlm: currentBalance,
        thresholdXlm: minBalanceXlm,
        autoRotate: true,
      });

      try {
        const rotationResult = await this.rotateActiveKey(
          undefined,
          "low_balance",
        );
        return {
          rotated: true,
          activePublicKey: rotationResult.activeKey.publicKey,
          balanceXlm: rotationResult.activeKey.balanceXlm,
        };
      } catch (err) {
        logger.error("relayer_low_balance_auto_rotation_failed", {
          error: (err as Error).message,
        });
      }
    }

    return {
      rotated: false,
      activePublicKey: active.publicKey,
      balanceXlm: active.balanceXlm,
    };
  }

  /**
   * Automate funding for a relayer account.
   * In testnet/futurenet/local, uses Friendbot.
   */
  public async fundKey(
    publicKey: string,
    friendbotUrl?: string,
  ): Promise<{ success: boolean; message: string }> {
    // SECURITY: Ignore user-supplied friendbotUrl to prevent SSRF.
    // An attacker could pass http://169.254.169.254/... to exfiltrate
    // cloud metadata via the error response. Only use server-configured URLs.
    const url =
      config.friendbotUrl ||
      "https://friendbot-futurenet.stellar.org";

    if (config.testMode) {
      const key = Array.from(this.keys.values()).find(
        (k) => k.publicKey === publicKey,
      );
      if (key) {
        key.balanceXlm = (key.balanceXlm || 0) + 10000;
        key.lastBalanceCheckAt = new Date().toISOString();
        if (key.status === "low_balance") {
          key.status = key.role === "primary" ? "active" : "standby";
        }
      }
      return {
        success: true,
        message: `Funded ${publicKey} with 10,000 test XLM`,
      };
    }

    try {
      const response = await fetch(`${url}?addr=${encodeURIComponent(publicKey)}`);
      if (response.ok) {
        logger.info("friendbot_funding_success", { publicKey });
        return { success: true, message: `Successfully funded ${publicKey}` };
      } else {
        // Do not echo the response body — it may contain sensitive
        // information if the URL was misconfigured or pointed at an
        // internal service.
        logger.warn("friendbot_funding_failed", {
          publicKey,
          status: response.status,
        });
        return {
          success: false,
          message: `Friendbot returned status ${response.status}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        message: `Funding failed: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Get health status & summary of relayer keys for diagnostic / health endpoints.
   */
  public getKeyHealth(): RelayerKeyHealth {
    this.expireDrains();
    const active = this.getActiveKey();
    const secondary =
      Array.from(this.keys.values()).find(
        (k) => k.id !== this.activeKeyId && k.role === "secondary",
      ) || null;

    const allSummaries = Array.from(this.keys.values()).map((k) =>
      this.summarizeKey(k),
    );

    const availableStandby = allSummaries.filter(
      (k) =>
        (k.status === "standby" || k.status === "active") &&
        !this.persistedRevocations.has(k.publicKey),
    ).length;

    const alerts: string[] = [];
    if (!active) {
      alerts.push("No active relayer key configured");
    } else if (
      active.balanceXlm !== null &&
      active.balanceXlm < this.minBalanceThresholdXlm
    ) {
      alerts.push(
        `Active key balance (${active.balanceXlm} XLM) is below threshold (${this.minBalanceThresholdXlm} XLM)`,
      );
    }

    if (!secondary) {
      alerts.push("No secondary/standby relayer key configured for failover");
    }

    const isHealthy = alerts.length === 0;
    const isDegraded = alerts.length > 0 && active !== null;

    return {
      status: isHealthy ? "healthy" : isDegraded ? "degraded" : "critical",
      activeKey: active ? this.summarizeKey(active) : null,
      secondaryKey: secondary ? this.summarizeKey(secondary) : null,
      totalKeys: this.keys.size,
      availableStandbyKeys: availableStandby,
      minBalanceThresholdXlm: this.minBalanceThresholdXlm,
      autoRotateEnabled: this.autoRotateEnabled,
      keys: allSummaries,
      alerts,
    };
  }

  /**
   * List all managed relayer keys.
   */
  public getAllKeys(): RelayerKeySummary[] {
    return Array.from(this.keys.values()).map((k) => this.summarizeKey(k));
  }

  /**
   * Set balance threshold in XLM for alerts & failover.
   */
  public setMinBalanceThreshold(thresholdXlm: number): void {
    this.minBalanceThresholdXlm = thresholdXlm;
  }

  /**
   * Enable or disable auto rotation on low balance.
   */
  public setAutoRotateEnabled(enabled: boolean): void {
    this.autoRotateEnabled = enabled;
  }

  /**
   * Helper to summarize key metadata without leaking secrets.
   */
  private summarizeKey(key: RelayerManagedKey): RelayerKeySummary {
    const now = Date.now();
    const created = new Date(key.createdAt).getTime();
    const ageDays = Math.max(0, Math.round((now - created) / (1000 * 86400)));

    return {
      id: key.id,
      publicKey: key.publicKey,
      role: key.role,
      status: key.status,
      signerType: key.signerType,
      balanceXlm: key.balanceXlm,
      lastBalanceCheckAt: key.lastBalanceCheckAt,
      txCount: key.txCount,
      createdAt: key.createdAt,
      activatedAt: key.activatedAt,
      ageDays,
      lastUsedAt: key.lastUsedAt,
      lastRotatedAt: key.lastRotatedAt,
      drainUntil: key.drainUntil ? new Date(key.drainUntil).toISOString() : null,
      revokedReason: key.revokedReason ?? null,
    };
  }

  private async notifyRotation(
    newKey: RelayerManagedKey,
    oldKey: RelayerManagedKey | null,
    trigger: string,
  ): Promise<void> {
    for (const listener of this.rotationListeners) {
      try {
        await listener(newKey, oldKey, trigger);
      } catch (err) {
        logger.error("rotation_listener_error", {
          error: (err as Error).message,
        });
      }
    }
  }

  private updateMetrics(): void {
    for (const key of this.keys.values()) {
      if (key.balanceXlm !== null) {
        relayerKeyBalance.set(
          { key_id: key.id, role: key.role },
          key.balanceXlm,
        );
      }
      if (key.activatedAt) {
        const ageSec = Math.max(
          0,
          Math.floor((Date.now() - new Date(key.activatedAt).getTime()) / 1000),
        );
        relayerKeyAgeSeconds.set(
          { key_id: key.id },
          ageSec,
        );
      }
    }

    // Age of the identity currently signing: drives the max-key-age alert.
    const active = this.getActiveKey();
    relayerActiveKeyAgeSeconds.set(
      active?.activatedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(active.activatedAt).getTime()) / 1000))
        : 0,
    );
    // Standbys known to hold enough XLM to take over immediately.
    relayerFundedStandbyKeys.set(
      this.standbyCandidates().filter(
        (k) => k.balanceXlm !== null && k.balanceXlm >= this.minBalanceThresholdXlm,
      ).length,
    );
    relayerDrainingKeys.set(
      Array.from(this.keys.values()).filter((k) => k.status === "draining").length,
    );
  }

  /**
   * Reset manager state (for testing).
   */
  public reset(): void {
    this.keys.clear();
    this.activeKeyId = null;
    this.rotationListeners.clear();
    this.initialized = false;
    this.persistedRevocations.clear();
    this.outstanding.clear();
    this.signingPolicy = null;
  }
}

// Global Singleton Instance
export const relayerKeyManager = new RelayerKeyManager();
