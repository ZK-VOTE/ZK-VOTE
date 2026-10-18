/**
 * Relayer Signing Policy — value/privilege tiers, co-signer approvals, halt (#746)
 *
 * The relayer hot key used to sign anything handed to it. This policy sits in
 * front of every relayer signature and decides, from the transaction itself,
 * how much authority the signature needs:
 *
 *   hot   value below the hot limit, no privileged ops   → hot key alone
 *   warm  value below the warm limit                     → 1 co-signer approval
 *                                                          (or audited break-glass)
 *   cold  above the warm limit, or any privileged op     → 2 distinct co-signers
 *         (setOptions, accountMerge, trust-flag changes, …)
 *
 * Tier is derived from the operations, never from a caller-supplied label, so
 * a request cannot talk its way into a lower tier. Approvals are HMACs bound
 * to the exact transaction hash and tier, so an approval for one transaction
 * cannot be replayed onto another.
 *
 * Option analysis (why an application gate and not only on-chain multisig):
 *  - Stellar multisig (co-signer keys as account signers with thresholds) is
 *    the strongest control but adds a network round-trip per co-signer and
 *    stalls every signature when a co-signer is offline; it fits the cold tier.
 *  - MPC/threshold ECDSA-EdDSA removes the single hot key but needs a
 *    multi-party ceremony per signature (tens to hundreds of ms of extra
 *    latency) and a separate operational track.
 *  - HSM signing keeps the key non-exportable but does not reduce the
 *    authority of whoever can call it (non-goal here; see HsmSigner).
 * This gate bounds blast radius today for every tier with ~0 latency on the
 * hot path; cold-tier operations should additionally be configured as
 * on-chain multisig.
 *
 * A co-signer halt stops all signing except a compromise sweep.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "crypto";

export type SigningTier = "hot" | "warm" | "cold";
export type SigningPurpose = "normal" | "sweep";

const TIER_RANK: Record<SigningTier, number> = { hot: 0, warm: 1, cold: 2 };
const REQUIRED_APPROVALS: Record<SigningTier, number> = { hot: 0, warm: 1, cold: 2 };

/**
 * Operations that change who controls the account or move all of its value.
 * These are cold no matter the amount.
 */
const PRIVILEGED_OPS = new Set([
  "setOptions",
  "accountMerge",
  "allowTrust",
  "setTrustLineFlags",
  "revokeSponsorship",
  "beginSponsoringFutureReserves",
  "clawback",
  "clawbackClaimableBalance",
]);

export class SigningRefusedError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "SigningRefusedError";
  }
}

export interface TierLimits {
  /** Inclusive upper bound for the hot tier, in stroops (1e-7 units). */
  hot: bigint;
  /** Inclusive upper bound for the warm tier, in stroops. */
  warm: bigint;
}

export interface SigningPolicyOptions {
  /** Per asset code; "*" applies to assets without their own entry. */
  limits: Record<string, TierLimits>;
  /** Co-signer id → shared HMAC secret. */
  cosigners: Record<string, string>;
  /** Break-glass secret; lets a warm (never cold) tx through without co-signers. */
  breakGlassSecret?: string;
  /**
   * RELAYER_SWEEP_SAFE_ACCOUNT. The only destination a sweep may pay; taken
   * from configuration, never from the caller.
   */
  sweepSafeAccount?: string;
  /** Turn the tier gate off entirely (halt still applies). */
  tiersEnabled?: boolean;
  now?: () => number;
}

export interface TierClassification {
  tier: SigningTier;
  privilegedOps: string[];
  /** Total moved per asset code, in stroops. */
  valueByAsset: Record<string, bigint>;
}

export interface SignAuthorization {
  approvals?: string[];
  breakGlass?: string;
  purpose?: SigningPurpose;
}

const STROOPS = 10_000_000n;

export function xlmToStroops(units: number | string): bigint {
  const [whole, frac = ""] = String(units).split(".");
  return BigInt(whole || "0") * STROOPS + BigInt((frac + "0000000").slice(0, 7));
}

function assetCode(asset: any): string {
  if (!asset) return "XLM";
  if (typeof asset.isNative === "function" && asset.isNative()) return "XLM";
  if (asset.type === "native") return "XLM";
  return String(asset.code ?? asset.getCode?.() ?? "UNKNOWN");
}

function innerTransaction(tx: any): any {
  return tx?.innerTransaction ?? tx;
}

/** Operations of a (possibly fee-bumped) transaction. */
export function transactionOperations(tx: any): any[] {
  return innerTransaction(tx)?.operations ?? [];
}

/** Value moved by one operation, as [assetCode, stroops], if any. */
function operationValue(op: any): [string, bigint] | null {
  switch (op.type) {
    case "payment":
      return [assetCode(op.asset), xlmToStroops(op.amount)];
    case "pathPaymentStrictSend":
      return [assetCode(op.sendAsset), xlmToStroops(op.sendAmount)];
    case "pathPaymentStrictReceive":
      return [assetCode(op.sendAsset), xlmToStroops(op.sendMax)];
    case "createAccount":
      return ["XLM", xlmToStroops(op.startingBalance)];
    case "createClaimableBalance":
      return [assetCode(op.asset), xlmToStroops(op.amount)];
    default:
      return null;
  }
}

export function issueApproval(
  cosignerId: string,
  secret: string,
  txHashHex: string,
  tier: SigningTier,
  expiresAtMs: number,
): string {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`zkvote-relayer-approval:v1:${txHashHex}:${tier}:${expiresAtMs}`)
    .digest("hex");
  return `${cosignerId}.${expiresAtMs}.${mac}`;
}

export function actionSubjectHash(action: string): string {
  return crypto.createHash("sha256").update(`zkvote-relayer-action:${action}`).digest("hex");
}

/** Co-signer approval for an action such as `sweep:<publicKey>`. */
export function issueActionApproval(
  cosignerId: string,
  secret: string,
  action: string,
  expiresAtMs: number,
): string {
  return issueApproval(cosignerId, secret, actionSubjectHash(action), "cold", expiresAtMs);
}

function macEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return (
    ab.length === bb.length &&
    ab.length > 0 &&
    crypto.timingSafeEqual(new Uint8Array(ab), new Uint8Array(bb))
  );
}

export class SigningPolicy {
  private haltState: { reason: string; by: string; at: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: SigningPolicyOptions) {
    this.now = options.now ?? Date.now;
  }

  classify(tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction): TierClassification {
    const valueByAsset: Record<string, bigint> = {};
    const privilegedOps: string[] = [];
    for (const op of transactionOperations(tx)) {
      if (PRIVILEGED_OPS.has(op.type)) privilegedOps.push(op.type);
      const value = operationValue(op);
      if (value) valueByAsset[value[0]] = (valueByAsset[value[0]] ?? 0n) + value[1];
    }

    let tier: SigningTier = privilegedOps.length > 0 ? "cold" : "hot";
    for (const [code, total] of Object.entries(valueByAsset)) {
      const limits = this.options.limits[code] ?? this.options.limits["*"];
      // An asset with no limits configured is never auto-signed.
      const assetTier: SigningTier = !limits
        ? "cold"
        : total <= limits.hot
          ? "hot"
          : total <= limits.warm
            ? "warm"
            : "cold";
      if (TIER_RANK[assetTier] > TIER_RANK[tier]) tier = assetTier;
    }
    return { tier, privilegedOps, valueByAsset };
  }

  /** Throws SigningRefusedError unless `tx` may be signed with `auth`. */
  authorize(
    tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
    auth: SignAuthorization = {},
  ): TierClassification {
    if (auth.purpose === "sweep") {
      this.assertSweepShape(tx, this.options.sweepSafeAccount);
      return this.classify(tx);
    }
    if (this.haltState) {
      throw new SigningRefusedError(
        "halted",
        `Relayer signing is halted by ${this.haltState.by}: ${this.haltState.reason}`,
      );
    }

    const classification = this.classify(tx);
    if (this.options.tiersEnabled === false) return classification;

    const required = REQUIRED_APPROVALS[classification.tier];
    if (required === 0) return classification;

    const txHash = tx.hash().toString("hex");
    if (
      classification.tier === "warm" &&
      auth.breakGlass &&
      this.verifyBreakGlass(auth.breakGlass, txHash)
    ) {
      return classification;
    }

    const approvers = this.validApprovers(auth.approvals ?? [], txHash, classification.tier);
    if (approvers.size < required) {
      throw new SigningRefusedError(
        "tier_approval_missing",
        `${classification.tier}-tier transaction needs ${required} co-signer approval(s), got ${approvers.size}` +
          (classification.privilegedOps.length
            ? ` (privileged: ${classification.privilegedOps.join(", ")})`
            : ""),
      );
    }
    return classification;
  }

  /** Distinct co-signers whose approval matches this exact hash and tier. */
  private validApprovers(tokens: string[], txHash: string, tier: SigningTier): Set<string> {
    const approvers = new Set<string>();
    for (const token of tokens) {
      const [id, exp, mac] = String(token).split(".");
      const secret = this.options.cosigners[id];
      const expiresAt = Number(exp);
      if (!secret || !Number.isFinite(expiresAt) || expiresAt < this.now()) continue;
      const expected = issueApproval(id, secret, txHash, tier, expiresAt).split(".")[2];
      if (macEquals(mac ?? "", expected)) approvers.add(id);
    }
    return approvers;
  }

  /**
   * Verify a co-signer approval over an action rather than a transaction
   * (e.g. "sweep:G…", "compromise:G…"). Returns the approving co-signer id,
   * or null. Operator names in admin requests are self-asserted under the
   * shared admin token; this is what makes a second person cryptographic.
   */
  verifyActionApproval(token: string | undefined, action: string): string | null {
    if (!token) return null;
    const approvers = this.validApprovers([token], actionSubjectHash(action), "cold");
    return approvers.values().next().value ?? null;
  }

  /** Break-glass is an approval token from the "break-glass" identity, warm tier only. */
  private verifyBreakGlass(token: string, txHash: string): boolean {
    const secret = this.options.breakGlassSecret;
    if (!secret) return false;
    const [tokenId, exp, mac] = String(token).split(".");
    const expiresAt = Number(exp);
    if (tokenId !== "break-glass" || !Number.isFinite(expiresAt) || expiresAt < this.now()) {
      return false;
    }
    const expected = issueApproval("break-glass", secret, txHash, "warm", expiresAt).split(".")[2];
    return macEquals(mac ?? "", expected);
  }

  /**
   * A sweep may only move value to the pre-provisioned safe account: payment
   * or accountMerge to that destination, optionally with bumpSequence. Any
   * other operation means purpose "sweep" is being used as a tier bypass.
   */
  private assertSweepShape(
    tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
    destination?: string,
  ): void {
    if (!destination) {
      throw new SigningRefusedError("sweep_unauthorized", "Sweep has no configured safe destination");
    }
    const ops = transactionOperations(tx);
    const ok =
      ops.length > 0 &&
      ops.every(
        (op) =>
          op.type === "bumpSequence" ||
          ((op.type === "payment" || op.type === "accountMerge") &&
            op.destination === destination),
      );
    if (!ok) {
      throw new SigningRefusedError(
        "sweep_shape_invalid",
        "Sweep transactions may only pay or merge into the configured safe account",
      );
    }
  }

  halt(reason: string, by: string): void {
    this.haltState = { reason, by, at: this.now() };
  }

  resume(): void {
    this.haltState = null;
  }

  getHaltState(): { reason: string; by: string; at: number } | null {
    return this.haltState;
  }
}

// ── Config parsing ──────────────────────────────────────────────────────────

/** "XLM:1000:10000,USDC:500:5000,*:100:1000" → limits in stroops. */
export function parseTierLimits(spec: string): Record<string, TierLimits> {
  const limits: Record<string, TierLimits> = {};
  for (const entry of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [code, hot, warm] = entry.split(":");
    if (!code || hot === undefined || warm === undefined) {
      throw new Error(`Invalid tier limit entry "${entry}" (expected CODE:HOT:WARM)`);
    }
    const parsed = { hot: xlmToStroops(hot), warm: xlmToStroops(warm) };
    if (parsed.warm < parsed.hot) {
      throw new Error(`Tier limit for ${code}: warm must be >= hot`);
    }
    limits[code] = parsed;
  }
  return limits;
}

/** "ops-a:secret1,ops-b:secret2" → { "ops-a": "secret1", ... }. */
export function parseCosigners(spec: string | undefined): Record<string, string> {
  const cosigners: Record<string, string> = {};
  for (const entry of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(":");
    if (idx <= 0) throw new Error("RELAYER_COSIGNER_KEYS entries must be id:secret");
    cosigners[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return cosigners;
}

export const DEFAULT_TIER_LIMITS = "XLM:10000:100000,USDC:1000:10000,EURC:1000:10000,*:100:1000";
