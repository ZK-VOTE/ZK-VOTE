/**
 * Relayer Fee Economics — Reserve Defense & Surge-Aware Estimation (#760)
 *
 * Implements dynamic fee estimation based on:
 * - Reserve defense: ensuring relayer maintains minimum reserve for operations
 * - Surge awareness: adjusting fees based on network load and fee volatility
 * - Historical tracking: analyzing fee trends to predict future costs
 * - Fairness: distributing fees equitably across operations
 *
 * It also owns the policy for sponsored (zero-fee) vote submission. A voter
 * never signs or funds a Stellar transaction: they sign a domain-separated
 * authorization object off-chain and hand it to the relayer. This module owns the
 * policy that decides whether the relayer is willing to pay for that vote:
 *
 *  - typed authorization + Ed25519 verification, expiry and nonce replay checks;
 *  - per-DAO daily / per-vote sponsorship budgets;
 *  - a bounded token bucket keyed by (daoId, voter commitment, relayer) rather
 *    than by IP — abuse costs are charged to this credential so a voter can
 *    rotate networks without escaping the limit;
 *  - a relayer reserve gate that degrades gracefully (RELAYER_RESERVE_LOW)
 *    instead of submitting a vote that the account cannot afford;
 *  - an in-memory metrics collector (counters + small histograms) exposing
 *    sponsored fee spend and rejection reasons.
 *
 * All sponsorship state is in-memory but behind interfaces (ReplayStore,
 * TokenBucket quota, SponsorshipBudget snapshots) so a deployment can persist
 * it later without changing callers.
 */

import { log } from "./logger.js";
import { getDb } from "./db.js";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { z } from "zod";

// Reserve thresholds (in XLM)
const MINIMUM_OPERATING_RESERVE = 50; // Minimum to keep operations running
const SAFE_OPERATING_RESERVE = 100; // Target comfortable reserve
const PANIC_RESERVE = 20; // Alert threshold

// Fee parameters
const BASE_FEE_STROOPS = 100; // Stellar base fee
const SURGE_MULTIPLIER_NORMAL = 1.0;
const SURGE_MULTIPLIER_HIGH = 2.0;
const SURGE_MULTIPLIER_CRITICAL = 4.0;

export interface FeeEstimate {
  baseFee: number; // Per operation in stroops
  surgeMultiplier: number;
  totalFee: number; // Per operation after surge
  recommendedForOps: number; // Fee for full batch operation count
  reserveStatus: "healthy" | "warning" | "critical";
  networkStatus: "normal" | "elevated" | "surge";
}

export interface RelayerReserveStatus {
  totalBalance: number; // In XLM
  reservedForSponsorship: number; // Locked by claimable balances
  availableForOperations: number; // Free to use
  minimumRequired: number;
  status: "healthy" | "warning" | "critical";
  riskFactors: string[];
}

/**
 * Analyzes recent fee trends to detect surge conditions.
 * Returns a multiplier to apply to base fees.
 */
export async function calculateSurgeMultiplier(): Promise<number> {
  const db = getDb();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  // Get average fee paid in last hour
  const recentFees = db
    .prepare(
      `
      SELECT AVG(fee_per_op) as avg_fee, MAX(fee_per_op) as max_fee
      FROM transaction_fees
      WHERE submitted_at > ?
      `,
    )
    .get(oneHourAgo) as any;

  if (!recentFees || !recentFees.avg_fee) {
    return SURGE_MULTIPLIER_NORMAL;
  }

  const avgFee = recentFees.avg_fee;

  // Calculate surge based on deviation from base
  const surgeRatio = avgFee / BASE_FEE_STROOPS;

  if (surgeRatio > 3.0) {
    return SURGE_MULTIPLIER_CRITICAL; // Network in critical state
  } else if (surgeRatio > 1.5) {
    return SURGE_MULTIPLIER_HIGH; // Elevated fees
  }

  return SURGE_MULTIPLIER_NORMAL; // Normal conditions
}

/**
 * Evaluates relayer reserve status.
 * Used to determine if operations should be throttled or rejected.
 */
export async function assessRelayerReserve(
  totalBalance: number,
  reservedForSponsorship: number,
  estimatedUpcomingFees: number = 0,
): Promise<RelayerReserveStatus> {
  const availableForOperations = totalBalance - reservedForSponsorship;
  const minimumRequired = MINIMUM_OPERATING_RESERVE;

  const riskFactors: string[] = [];
  let status: "healthy" | "warning" | "critical" = "healthy";

  if (availableForOperations < minimumRequired) {
    status = "critical";
    riskFactors.push(
      `Below minimum reserve: ${availableForOperations.toFixed(2)} XLM`,
    );
  } else if (availableForOperations < SAFE_OPERATING_RESERVE) {
    status = "warning";
    riskFactors.push(
      `Below safe reserve: ${availableForOperations.toFixed(2)} XLM`,
    );
  }

  if (availableForOperations - estimatedUpcomingFees < PANIC_RESERVE) {
    if (status === "healthy") status = "warning";
    riskFactors.push(`Upcoming fees would deplete reserve`);
  }

  if (totalBalance < 10) {
    status = "critical";
    riskFactors.push(`Critical balance: ${totalBalance.toFixed(2)} XLM`);
  }

  log("info", "relayer_reserve_assessed", {
    totalBalance: totalBalance.toFixed(2),
    availableForOperations: availableForOperations.toFixed(2),
    status,
    riskFactors: riskFactors.length > 0 ? riskFactors : undefined,
  });

  return {
    totalBalance,
    reservedForSponsorship,
    availableForOperations,
    minimumRequired,
    status,
    riskFactors,
  };
}

/**
 * Estimates fees for an operation given current network conditions.
 * Factors in surge pricing and reserve defense.
 */
export async function estimateFee(
  opCount: number,
  relayerBalance: number,
  sponsoredCount: number = 0,
): Promise<FeeEstimate> {
  const surgeMultiplier = await calculateSurgeMultiplier();

  // Determine network status
  const networkStatus =
    surgeMultiplier > 2.0
      ? "surge"
      : surgeMultiplier > 1.2
        ? "elevated"
        : "normal";

  // Base fee calculation
  const baseFee = BASE_FEE_STROOPS * surgeMultiplier;
  const totalFee = baseFee * opCount;

  // Convert stroops to XLM for reserve assessment
  const totalFeeXlm = totalFee / 10_000_000;

  // Assess reserve impact
  const reserveStatus =
    relayerBalance - totalFeeXlm < MINIMUM_OPERATING_RESERVE
      ? "critical"
      : relayerBalance - totalFeeXlm < SAFE_OPERATING_RESERVE
        ? "warning"
        : "healthy";

  // If reserve is critical, apply additional surge to encourage batching
  const adjustedSurgeMultiplier =
    reserveStatus === "critical"
      ? surgeMultiplier * 2.0
      : reserveStatus === "warning"
        ? surgeMultiplier * 1.5
        : surgeMultiplier;

  const adjustedTotalFee = BASE_FEE_STROOPS * adjustedSurgeMultiplier * opCount;

  return {
    baseFee: Math.ceil(BASE_FEE_STROOPS * adjustedSurgeMultiplier),
    surgeMultiplier: adjustedSurgeMultiplier,
    totalFee: Math.ceil(adjustedTotalFee),
    recommendedForOps: Math.ceil(adjustedTotalFee),
    reserveStatus,
    networkStatus: networkStatus as "normal" | "elevated" | "surge",
  };
}

/**
 * Records a transaction fee for historical tracking.
 * Used to calculate surge multipliers and analyze fee trends.
 */
export async function recordTransactionFee(
  txHash: string,
  feePerOp: number,
  opCount: number,
  totalFee: number,
): Promise<void> {
  const db = getDb();

  try {
    db.prepare(
      `
      INSERT INTO transaction_fees
      (tx_hash, fee_per_op, op_count, total_fee, submitted_at)
      VALUES (?, ?, ?, ?, ?)
      `,
    ).run(txHash, feePerOp, opCount, totalFee, new Date().toISOString());
  } catch (e: any) {
    log("warn", "fee_recording_failed", {
      txHash,
      error: e.message,
    });
  }
}

/**
 * Analyzes fee trends over a time period.
 * Returns statistics for fee governance and alert thresholds.
 */
export async function analyzeFeeMetrics(
  periodMs: number = 24 * 60 * 60 * 1000, // 24 hours default
): Promise<{
  avgFee: number;
  maxFee: number;
  minFee: number;
  p95Fee: number;
  txCount: number;
  surgePercent: number;
}> {
  const db = getDb();
  const periodStart = Date.now() - periodMs;

  const stats = db
    .prepare(
      `
      SELECT
        AVG(fee_per_op) as avg_fee,
        MAX(fee_per_op) as max_fee,
        MIN(fee_per_op) as min_fee,
        COUNT(*) as tx_count
      FROM transaction_fees
      WHERE submitted_at > ?
      `,
    )
    .get(periodStart) as any;

  // Calculate p95
  const p95Result = db
    .prepare(
      `
      SELECT fee_per_op
      FROM transaction_fees
      WHERE submitted_at > ?
      ORDER BY fee_per_op DESC
      LIMIT 1 OFFSET (
        SELECT MAX(CAST(COUNT(*) * 0.05 AS INTEGER))
        FROM transaction_fees
        WHERE submitted_at > ?
      )
      `,
    )
    .get(periodStart, periodStart) as any;

  const p95 = p95Result?.fee_per_op || stats?.max_fee || BASE_FEE_STROOPS;

  const avgFee = stats?.avg_fee || BASE_FEE_STROOPS;
  const surgePercent = ((avgFee - BASE_FEE_STROOPS) / BASE_FEE_STROOPS) * 100;

  return {
    avgFee: Math.round(avgFee),
    maxFee: Math.round(stats?.max_fee || BASE_FEE_STROOPS),
    minFee: Math.round(stats?.min_fee || BASE_FEE_STROOPS),
    p95Fee: Math.round(p95),
    txCount: stats?.tx_count || 0,
    surgePercent: Math.max(0, surgePercent),
  };
}

/**
 * Determines if operations should be throttled based on reserve and surge conditions.
 * Returns true if new operations should be rejected or delayed.
 */
export async function shouldThrottleOperations(
  reserveStatus: RelayerReserveStatus,
  feeEstimate: FeeEstimate,
): Promise<boolean> {
  // Critical reserve + surge = definitely throttle
  if (
    reserveStatus.status === "critical" &&
    feeEstimate.networkStatus !== "normal"
  ) {
    return true;
  }

  // Critical reserve alone
  if (
    reserveStatus.status === "critical" &&
    reserveStatus.availableForOperations < PANIC_RESERVE
  ) {
    return true;
  }

  // Warning reserve with critical surge
  if (
    reserveStatus.status === "warning" &&
    feeEstimate.networkStatus === "surge"
  ) {
    return true;
  }

  return false;
}

/**
 * Provides fee governance recommendations to relayer operators with live data.
 * Queries actual relayer account state and recent fee metrics.
 */
export async function getFeeGovernanceReport(params: {
  relayerAccountId: string;
  horizonUrl: string;
}): Promise<{
  currentEstimate: FeeEstimate;
  reserveStatus: RelayerReserveStatus;
  feeMetrics: Awaited<ReturnType<typeof analyzeFeeMetrics>>;
  recommendations: string[];
  runbookUrl: string;
  confidence: "high" | "medium" | "low";
  surgeWindow?: { start: Date; expectedEnd: Date };
  batchWindow?: { optimalSize: number; estimatedSavings: number };
}> {
  // Query live relayer account state
  const { totalBalance, reservedForSponsorship, pendingOperations } =
    await queryLiveRelayerState(params.relayerAccountId, params.horizonUrl);

  // Get recent fee metrics
  const feeMetrics = await analyzeFeeMetrics();

  // Calculate current fee estimate based on live state
  const currentEstimate = await estimateFee(
    pendingOperations,
    totalBalance,
    reservedForSponsorship,
  );

  // Assess reserve with live data
  const estimatedUpcomingFees =
    (currentEstimate.totalFee / 10_000_000) * pendingOperations;
  const reserveStatus = await assessRelayerReserve(
    totalBalance,
    reservedForSponsorship,
    estimatedUpcomingFees,
  );

  const recommendations: string[] = [];
  let confidence: "high" | "medium" | "low" = "high";
  let surgeWindow: { start: Date; expectedEnd: Date } | undefined;
  let batchWindow: { optimalSize: number; estimatedSavings: number } | undefined;

  // Analyze surge conditions and provide time-based recommendations
  if (feeMetrics.surgePercent > 50) {
    recommendations.push(
      `Network fees elevated by ${feeMetrics.surgePercent.toFixed(0)}%. Consider batching operations.`,
    );
    confidence = "medium";

    // Estimate surge window based on historical patterns
    const avgSurgeDurationMs = 2 * 60 * 60 * 1000; // 2 hours typical
    surgeWindow = {
      start: new Date(Date.now() - 30 * 60 * 1000), // Assume started 30min ago
      expectedEnd: new Date(Date.now() + avgSurgeDurationMs),
    };
  }

  // Calculate optimal batch size and savings
  if (pendingOperations > 1) {
    const singleOpFee = currentEstimate.baseFee;
    const batchedFee = currentEstimate.baseFee * 0.7; // 30% savings from batching
    const savings = (singleOpFee - batchedFee) * pendingOperations;
    
    batchWindow = {
      optimalSize: Math.min(100, Math.max(10, Math.ceil(pendingOperations / 5))),
      estimatedSavings: savings,
    };

    if (savings > 1000) {
      recommendations.push(
        `Batching ${batchWindow.optimalSize} operations could save ~${(savings / 10_000_000).toFixed(2)} XLM in fees.`,
      );
    }
  }

  // Reserve-based recommendations with specific thresholds
  if (reserveStatus.status === "critical") {
    recommendations.push(
      `URGENT: Relayer reserve at ${reserveStatus.availableForOperations.toFixed(2)} XLM. Deposit ${(SAFE_OPERATING_RESERVE - reserveStatus.availableForOperations).toFixed(2)} XLM immediately.`,
    );
    confidence = "high";
  } else if (reserveStatus.status === "warning") {
    recommendations.push(
      `Reserve at ${reserveStatus.availableForOperations.toFixed(2)} XLM. Plan to deposit ${(SAFE_OPERATING_RESERVE - reserveStatus.availableForOperations).toFixed(2)} XLM soon.`,
    );
  } else {
    recommendations.push(
      `Reserve healthy at ${reserveStatus.availableForOperations.toFixed(2)} XLM.`,
    );
  }

  // Network status recommendations with confidence adjustments
  if (currentEstimate.networkStatus === "surge") {
    recommendations.push(
      "Network in surge conditions. Defer non-urgent operations if possible.",
    );
    confidence = confidence === "high" ? "medium" : "low";
  } else if (currentEstimate.networkStatus === "elevated") {
    recommendations.push(
      "Network fees elevated but stable. Normal operations recommended.",
    );
  }

  // Confidence assessment based on data freshness
  if (feeMetrics.txCount < 10) {
    recommendations.push(
      "Low recent transaction volume. Fee estimates may be less accurate.",
    );
    confidence = "low";
  }

  return {
    currentEstimate,
    reserveStatus,
    feeMetrics,
    recommendations,
    runbookUrl: "https://docs.zkvote.io/ops/fee-governance",
    confidence,
    surgeWindow,
    batchWindow,
  };
}

/**
 * Query live relayer account state from Horizon.
 * Returns balance, reserved amounts, and pending operation count.
 */
async function queryLiveRelayerState(
  accountId: string,
  horizonUrl: string,
): Promise<{
  totalBalance: number;
  reservedForSponsorship: number;
  pendingOperations: number;
}> {
  try {
    const response = await fetch(`${horizonUrl}/accounts/${accountId}`);
    
    if (!response.ok) {
      throw new Error(`Horizon API returned ${response.status}`);
    }

    const account = await response.json();
    
    // Extract XLM balance
    const xlmBalance = account.balances.find(
      (b: any) => b.asset_type === "native",
    );
    const totalBalance = xlmBalance
      ? parseFloat(xlmBalance.balance)
      : 0;

    // Calculate reserved amounts (base reserve + sponsorships + offers)
    const baseReserve = parseFloat(account.num_subentries || "0") * 0.5 + 1.0;
    const numSponsoring = parseInt(account.num_sponsoring || "0", 10);
    const reservedForSponsorship = baseReserve + numSponsoring * 0.5;

    // Query pending operations from database
    const db = getDb();
    const pending = db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM pending_operations
        WHERE status = 'queued'
        AND created_at > datetime('now', '-1 hour')
        `,
      )
      .get() as any;

    const pendingOperations = pending?.count || 0;

    log("info", "relayer_state_queried", {
      accountId,
      totalBalance: totalBalance.toFixed(2),
      reservedForSponsorship: reservedForSponsorship.toFixed(2),
      pendingOperations,
    });

    return {
      totalBalance,
      reservedForSponsorship,
      pendingOperations,
    };
  } catch (err) {
    log("error", "relayer_state_query_failed", {
      accountId,
      error: (err as Error).message,
    });
    
    // Return safe defaults if query fails
    return {
      totalBalance: SAFE_OPERATING_RESERVE,
      reservedForSponsorship: 0,
      pendingOperations: 0,
    };
  }
}

// ── Sponsored vote policy ─────────────────────────────────────────────────

// ── Stable rejection codes ────────────────────────────────────────────────

export const RELAYER_REJECTION_CODES = [
  "INVALID_REQUEST",
  "INVALID_AUTHORIZATION",
  "UNSUPPORTED_VERSION",
  "DOMAIN_MISMATCH",
  "EXPIRED_AUTHORIZATION",
  "INVALID_SIGNATURE",
  "RELAYER_MISMATCH",
  "NONCE_REPLAY",
  "RATE_LIMITED",
  "BUDGET_EXHAUSTED",
  "RELAYER_RESERVE_LOW",
  "SUBMISSION_FAILED",
] as const;

export type RelayerRejectionCode = (typeof RELAYER_REJECTION_CODES)[number];

export class RelayerError extends Error {
  constructor(
    public readonly code: RelayerRejectionCode,
    public readonly statusCode: number,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "RelayerError";
    Error.captureStackTrace?.(this, RelayerError);
  }
}

// ── Authorization object ──────────────────────────────────────────────────

export const VOTE_AUTH_DOMAIN = "zkvote.vote-authorization.v1";
export const VOTE_AUTH_VERSION = 1;
/** Authorizations are short-lived: a long window would widen replay exposure. */
export const MAX_AUTH_LIFETIME_SECONDS = 600;
export const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const STROOPS_PER_XLM = 10_000_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const hexString = z.string().regex(/^(0x)?[0-9a-fA-F]{1,128}$/);
const numericId = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform((v) => String(v))
  .refine((v) => BigInt(v) <= 18_446_744_073_709_551_615n, "id exceeds u64 range");

export const voteAuthorizationSchema = z
  .object({
    version: z.number().int().nonnegative(),
    domain: z.string().min(1).max(128),
    chainId: z.string().min(1).max(256),
    daoId: numericId,
    proposalId: numericId,
    /** Stellar G-address, or an opaque voter identifier when privacy-bound. */
    voter: z.string().min(1).max(256),
    /** Optional privacy commitment; used (with daoId/relayer) as the abuse key. */
    commitment: hexString.optional(),
    nullifier: hexString,
    choice: z.union([
      z.boolean(),
      z.number().int().nonnegative().max(0xffffffff),
    ]),
    /** Relayer G-address that is authorized to pay the fee. */
    relayer: z.string().min(1).max(128),
    /** Unix seconds. */
    expiry: z.number().int().positive(),
    /** Caller-chosen unique value; replay is keyed by (voter, relayer, nonce). */
    nonce: z.string().min(1).max(128),
    /** Ed25519 public key that signed the payload (G-address, 0x-hex or base64). */
    signerPublicKey: z.string().min(1).max(256),
    /** Base64 Ed25519 detached signature over the canonical payload digest. */
    signature: z.string().min(1).max(512),
  })
  .strict();

export type VoteAuthorization = z.infer<typeof voteAuthorizationSchema>;
export type VoteAuthorizationFields = Omit<VoteAuthorization, "signature">;

export function normalizedChoice(choice: VoteAuthorization["choice"]): number {
  return typeof choice === "boolean" ? (choice ? 1 : 0) : choice;
}

/**
 * Length-prefixed, domain-separated canonical payload. Length prefixes make the
 * encoding injective even when fields contain the separator, so no two distinct
 * authorization objects can hash to the same digest.
 */
export function canonicalVoteAuthPayload(auth: VoteAuthorizationFields): string {
  const field = (value: string): string =>
    `${Buffer.byteLength(value, "utf8")}:${value}`;
  return [
    "zkvote-vote-auth-canonical-v1",
    field(VOTE_AUTH_DOMAIN),
    field(String(auth.version)),
    field(auth.domain),
    field(auth.chainId),
    field(String(auth.daoId)),
    field(String(auth.proposalId)),
    field(auth.voter),
    field(auth.commitment ? auth.commitment.toLowerCase() : ""),
    field(auth.nullifier.toLowerCase()),
    field(String(normalizedChoice(auth.choice))),
    field(auth.relayer),
    field(String(auth.expiry)),
    field(auth.nonce),
    field(auth.signerPublicKey),
  ].join("|");
}

export function voteAuthDigest(auth: VoteAuthorizationFields): Buffer {
  return createHash("sha256").update(canonicalVoteAuthPayload(auth)).digest();
}

/**
 * Node's crypto typings require views backed by ArrayBuffer (not the wider
 * ArrayBufferLike that Buffer carries). Copying into a fresh Uint8Array makes
 * the type explicit without changing the bytes.
 */
function bytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(buffer);
}

// DER wrappers turn raw 32-byte Ed25519 keys into Node KeyObjects.
// Uint8Array form avoids Buffer/ArrayBufferLike generic mismatches with the
// repo's pinned @types/node while producing byte-identical DER.
const ED25519_SPKI_PREFIX = Uint8Array.from(
  Buffer.from("302a300506032b6570032100", "hex"),
);
const ED25519_PKCS8_PREFIX = Uint8Array.from(
  Buffer.from("302e020100300506032b657004220420", "hex"),
);

export function decodeEd25519PublicKey(encoded: string): Buffer {
  let raw: Buffer;
  if (encoded.startsWith("G") && encoded.length >= 50) {
    try {
      raw = Buffer.from(new Uint8Array(StellarSdk.StrKey.decodeEd25519PublicKey(encoded)));
    } catch {
      throw new RelayerError(
        "INVALID_AUTHORIZATION",
        400,
        "signerPublicKey is not a valid Ed25519 public key",
      );
    }
  } else {
    const hex = encoded.startsWith("0x") ? encoded.slice(2) : encoded;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      raw = Buffer.from(hex, "hex");
    } else {
      raw = Buffer.from(encoded, "base64");
    }
  }
  if (raw.length !== 32) {
    throw new RelayerError(
      "INVALID_AUTHORIZATION",
      400,
      "signerPublicKey must encode 32 bytes",
    );
  }
  return raw;
}

function privateKeyFrom(secret: Buffer | string | KeyObject): KeyObject {
  if (typeof secret !== "string") {
    if (Buffer.isBuffer(secret)) {
      if (secret.length !== 32) {
        throw new Error("Ed25519 seed must be 32 bytes");
      }
      return createPrivateKey({
        key: Buffer.from(Uint8Array.from([...ED25519_PKCS8_PREFIX, ...bytes(secret)])),
        format: "der",
        type: "pkcs8",
      });
    }
    return secret;
  }
  if (secret.startsWith("S")) {
    const seed = Buffer.from(new Uint8Array(StellarSdk.StrKey.decodeEd25519SecretSeed(secret)));
    return privateKeyFrom(seed);
  }
  return createPrivateKey(secret);
}

/** Helper used by tests and by clients that sign on the server side. */
export function signVoteAuthorization(
  fields: VoteAuthorizationFields,
  secret: Buffer | string | KeyObject,
): VoteAuthorization {
  const draft = fields as VoteAuthorization;
  const signature = ed25519Sign(null, bytes(voteAuthDigest(draft)), privateKeyFrom(secret));
  return { ...draft, signature: signature.toString("base64") };
}

export function verifyVoteAuthorizationSignature(auth: VoteAuthorization): void {
  const raw = decodeEd25519PublicKey(auth.signerPublicKey);
  let signature: Buffer;
  try {
    signature = Buffer.from(auth.signature, "base64");
  } catch {
    throw new RelayerError("INVALID_SIGNATURE", 401, "Malformed signature");
  }
  const ok =
    signature.length === 64 &&
    ed25519Verify(
      null,
      bytes(voteAuthDigest(auth)),
      createPublicKey({
        key: Buffer.from(Uint8Array.from([...ED25519_SPKI_PREFIX, ...bytes(raw)])),
        format: "der",
        type: "spki",
      }),
      bytes(signature),
    );
  if (!ok) {
    throw new RelayerError(
      "INVALID_SIGNATURE",
      401,
      "Vote authorization signature does not match signerPublicKey",
    );
  }
}

export interface VerifyAuthorizationOptions {
  expectedRelayer: string;
  expectedChainId: string;
  /** Unix seconds; injectable so tests are deterministic. */
  nowSeconds?: number;
  clockSkewSeconds?: number;
}

/**
 * Full static verification. Replay/budget/reserve checks are policy decisions
 * made by the route; this function only proves the authorization is authentic,
 * current, and addressed to this relayer on this chain.
 */
export function verifyVoteAuthorization(
  auth: VoteAuthorization,
  options: VerifyAuthorizationOptions,
): void {
  if (auth.version !== VOTE_AUTH_VERSION) {
    throw new RelayerError(
      "UNSUPPORTED_VERSION",
      400,
      `Unsupported vote authorization version ${auth.version}`,
    );
  }
  if (auth.domain !== VOTE_AUTH_DOMAIN) {
    throw new RelayerError(
      "DOMAIN_MISMATCH",
      400,
      "Vote authorization domain tag does not match this service",
    );
  }
  if (auth.chainId !== options.expectedChainId) {
    throw new RelayerError(
      "DOMAIN_MISMATCH",
      400,
      "Vote authorization chainId does not match this network",
    );
  }
  if (auth.relayer !== options.expectedRelayer) {
    throw new RelayerError(
      "RELAYER_MISMATCH",
      400,
      "Vote authorization is addressed to a different relayer",
    );
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (auth.expiry <= now - skew) {
    throw new RelayerError(
      "EXPIRED_AUTHORIZATION",
      401,
      "Vote authorization has expired",
    );
  }
  if (auth.expiry > now + MAX_AUTH_LIFETIME_SECONDS + skew) {
    throw new RelayerError(
      "INVALID_AUTHORIZATION",
      400,
      "Vote authorization expiry is too far in the future",
    );
  }
  // When the voter is itself a Stellar account the signer must be that account;
  // commitment-based voters use a dedicated one-shot signing key instead.
  if (auth.voter.startsWith("G") && auth.voter !== auth.signerPublicKey) {
    throw new RelayerError(
      "INVALID_AUTHORIZATION",
      400,
      "voter account must equal signerPublicKey for G-address voters",
    );
  }
  verifyVoteAuthorizationSignature(auth);
}

/** Replay identity: the signer (or voter), the paying relayer, and the nonce. */
export function replayKey(auth: VoteAuthorization): string {
  return `${auth.signerPublicKey}|${auth.relayer}|${auth.nonce}`;
}

/** Abuse/rate-limit identity: no IP address is stored or keyed on. */
export function sponsorshipTokenKey(auth: VoteAuthorization): string {
  return `${auth.daoId}|${auth.commitment ?? auth.voter}|${auth.relayer}`;
}

// ── Replay protection (persistable) ───────────────────────────────────────

export interface ReplayStore {
  has(key: string): boolean | Promise<boolean>;
  put(key: string, expiresAtMs: number): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
  /** Atomic check-and-insert; returns true when the key was newly stored. */
  consume?(key: string, expiresAtMs: number): boolean | Promise<boolean>;
}

const MAX_REPLAY_ENTRIES = 50_000;

export class InMemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, number>();

  has(key: string): boolean {
    const expires = this.entries.get(key);
    if (expires === undefined) return false;
    if (expires <= Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  consume(key: string, expiresAtMs: number): boolean {
    if (this.has(key)) return false;
    this.put(key, expiresAtMs);
    return true;
  }

  put(key: string, expiresAtMs: number): void {
    if (expiresAtMs <= Date.now()) return;
    if (this.entries.size >= MAX_REPLAY_ENTRIES) {
      for (const [k, exp] of this.entries) {
        if (exp <= Date.now()) this.entries.delete(k);
      }
      // Bounded even under a sustained unique-nonce attack.
      while (this.entries.size >= MAX_REPLAY_ENTRIES) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, expiresAtMs);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

export class ReplayGuard {
  constructor(
    private readonly store: ReplayStore = new InMemoryReplayStore(),
    private readonly ttlMs = MAX_AUTH_LIFETIME_SECONDS * 1000,
  ) {}

  /** Atomically reject an already-used (voter|relayer, nonce) pair. */
  async consume(key: string, nowMs = Date.now()): Promise<void> {
    const expiresAtMs = nowMs + this.ttlMs;
    if (this.store.consume) {
      if (!(await this.store.consume(key, expiresAtMs))) {
        throw new RelayerError("NONCE_REPLAY", 409, "Vote authorization nonce already used");
      }
      return;
    }
    if (await this.store.has(key)) {
      throw new RelayerError("NONCE_REPLAY", 409, "Vote authorization nonce already used");
    }
    await this.store.put(key, expiresAtMs);
  }

  reset(): void {
    // In-memory stores expose clear(); persistent stores are reset by their owner.
    const store = this.store as ReplayStore & { clear?: () => void };
    store.clear?.();
  }
}

export const replayGuard = new ReplayGuard();

// ── Token bucket (abuse costs are charged here, never to the voter) ───────

export interface Quota {
  limit: number;
  remaining: number;
  /** Unix seconds at which the bucket is full again. */
  resetSeconds: number;
}

export class TokenBucket {
  private readonly buckets = new Map<
    string,
    { tokens: number; lastRefillMs: number }
  >();

  constructor(
    private readonly options: {
      capacity?: number;
      refillPerMinute?: number;
      maxKeys?: number;
      now?: () => number;
    } = {},
  ) {}

  private get capacity(): number {
    return this.options.capacity ?? envInt("SPONSORSHIP_TOKEN_CAPACITY", 30);
  }

  private get refillPerMinute(): number {
    return this.options.refillPerMinute ?? envInt("SPONSORSHIP_TOKEN_REFILL_PER_MIN", 10);
  }

  private refill(key: string, nowMs: number): { tokens: number; lastRefillMs: number } {
    let entry = this.buckets.get(key);
    if (!entry) {
      if (this.buckets.size >= (this.options.maxKeys ?? 10_000)) {
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      entry = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, entry);
    }
    const elapsed = Math.max(0, nowMs - entry.lastRefillMs);
    entry.tokens = Math.min(
      this.capacity,
      entry.tokens + (elapsed / 60_000) * this.refillPerMinute,
    );
    entry.lastRefillMs = nowMs;
    return entry;
  }

  quota(key: string, nowMs = this.options.now?.() ?? Date.now()): Quota {
    const entry = this.refill(key, nowMs);
    const secondsToFull =
      this.refillPerMinute > 0
        ? Math.ceil(((this.capacity - entry.tokens) / this.refillPerMinute) * 60)
        : 0;
    return {
      limit: this.capacity,
      remaining: Math.floor(entry.tokens),
      resetSeconds: Math.ceil((nowMs + secondsToFull * 1000) / 1000),
    };
  }

  /** Deduct `cost` tokens or throw a typed 429 with the current quota. */
  consume(key: string, cost = 1, nowMs = this.options.now?.() ?? Date.now()): Quota {
    const entry = this.refill(key, nowMs);
    if (entry.tokens < cost) {
      throw new RelayerError(
        "RATE_LIMITED",
        429,
        "Sponsorship rate limit exceeded",
        true,
      );
    }
    entry.tokens -= cost;
    return this.quota(key, nowMs);
  }

  /** Best-effort charge for rejected/spam requests; never masks the root error. */
  chargeAbuse(key: string, cost = 3): void {
    try {
      this.consume(key, cost);
    } catch {
      // The original rejection reason is what the caller needs to see.
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

export const tokenBucket = new TokenBucket();

// ── Fee estimation & per-DAO budget ───────────────────────────────────────

export interface VoteFeeEstimate {
  networkFeeStroops: number;
  resourceFeeStroops: number;
  totalStroops: number;
}

export function estimateVoteFee(): VoteFeeEstimate {
  const networkFeeStroops = envInt("VOTE_NETWORK_FEE_STROOPS", 10_000);
  const resourceFeeStroops = envInt("VOTE_RESOURCE_FEE_STROOPS", 100_000);
  const cap = envInt("VOTE_MAX_FEE_STROOPS", 500_000);
  const totalStroops = Math.min(cap, networkFeeStroops + resourceFeeStroops);
  recordFeeEstimate(totalStroops);
  return { networkFeeStroops, resourceFeeStroops, totalStroops };
}

export function stroopsToXlm(stroops: number): number {
  return stroops / STROOPS_PER_XLM;
}

export interface SponsorshipQuota {
  limitStroops: number;
  remainingStroops: number;
  /** Unix seconds at which the daily window resets. */
  resetSeconds: number;
}

interface BudgetWindow {
  startMs: number;
  spentStroops: number;
  reservedStroops: number;
}

export interface SponsorshipReservation {
  id: string;
  daoId: string;
  amountStroops: number;
}

/**
 * Per-DAO sponsorship budget with a fixed 24h (UTC-aligned) window. A
 * reservation is held during submission and either committed (success) or
 * released (failure), so concurrent requests cannot overspend the cap.
 */
export class SponsorshipBudget {
  private readonly windows = new Map<string, BudgetWindow>();
  private reservationCounter = 0;

  constructor(private readonly windowMs = 86_400_000) {}

  private windowFor(daoId: string, nowMs: number): BudgetWindow {
    const startMs = Math.floor(nowMs / this.windowMs) * this.windowMs;
    let window = this.windows.get(daoId);
    if (!window || window.startMs !== startMs) {
      window = { startMs, spentStroops: 0, reservedStroops: 0 };
      this.windows.set(daoId, window);
      // Keep the map bounded across many DAOs.
      if (this.windows.size > 10_000) {
        for (const [key, value] of this.windows) {
          if (value.startMs !== startMs && nowMs - value.startMs >= this.windowMs) {
            this.windows.delete(key);
          }
        }
      }
    }
    return window;
  }

  private dailyCap(): number {
    return envInt("SPONSORSHIP_DAILY_LIMIT_STROOPS", 50_000_000); // 5 XLM
  }

  private perVoteCap(): number {
    return envInt("SPONSORSHIP_PER_VOTE_LIMIT_STROOPS", 500_000); // 0.05 XLM
  }

  quota(daoId: string, nowMs = Date.now()): SponsorshipQuota {
    const window = this.windowFor(daoId, nowMs);
    return {
      limitStroops: this.dailyCap(),
      remainingStroops: Math.max(
        0,
        this.dailyCap() - window.spentStroops - window.reservedStroops,
      ),
      resetSeconds: Math.ceil((window.startMs + this.windowMs) / 1000),
    };
  }

  reserve(
    daoId: string,
    amountStroops: number,
    nowMs = Date.now(),
  ): SponsorshipReservation {
    if (!Number.isFinite(amountStroops) || amountStroops <= 0) {
      throw new RelayerError("INVALID_REQUEST", 400, "Invalid fee estimate");
    }
    if (amountStroops > this.perVoteCap()) {
      recordRejection("BUDGET_EXHAUSTED");
      throw new RelayerError(
        "BUDGET_EXHAUSTED",
        429,
        "Estimated vote fee exceeds the per-vote sponsorship cap",
      );
    }
    const window = this.windowFor(daoId, nowMs);
    if (window.spentStroops + window.reservedStroops + amountStroops > this.dailyCap()) {
      recordRejection("BUDGET_EXHAUSTED");
      throw new RelayerError(
        "BUDGET_EXHAUSTED",
        429,
        "DAO sponsorship budget exhausted for this window",
        true,
      );
    }
    window.reservedStroops += amountStroops;
    return {
      id: `${daoId}:${nowMs}:${++this.reservationCounter}`,
      daoId,
      amountStroops,
    };
  }

  commit(reservation: SponsorshipReservation, nowMs = Date.now()): void {
    const window = this.windowFor(reservation.daoId, nowMs);
    window.reservedStroops = Math.max(
      0,
      window.reservedStroops - reservation.amountStroops,
    );
    window.spentStroops += reservation.amountStroops;
  }

  release(reservation: SponsorshipReservation, nowMs = Date.now()): void {
    const window = this.windowFor(reservation.daoId, nowMs);
    window.reservedStroops = Math.max(
      0,
      window.reservedStroops - reservation.amountStroops,
    );
  }

  reset(): void {
    this.windows.clear();
  }
}

export const sponsorshipBudget = new SponsorshipBudget();

// ── Reserve threshold & graceful degradation ──────────────────────────────

let relayerReserveXlm = envNumber("RELAYER_RESERVE_XLM", 25);

export function getRelayerReserveXlm(): number {
  return relayerReserveXlm;
}

/** Ops/tests can feed the relayer's live balance into the gate. */
export function setRelayerReserveXlm(xlm: number): void {
  if (!Number.isFinite(xlm) || xlm < 0) {
    throw new Error("Relayer reserve must be a non-negative number of XLM");
  }
  relayerReserveXlm = xlm;
}

/**
 * Fail before submission when the relayer cannot cover the vote plus its
 * safety buffer. The caller maps RELAYER_RESERVE_LOW to 503 + Retry-After, so
 * clients can degrade to the normal (voter-funded) vote flow instead of
 * presenting an opaque 500.
 */
export function assertRelayerReserve(feeStroops: number): void {
  const threshold = envNumber("RELAYER_RESERVE_MIN_XLM", 10);
  if (relayerReserveXlm - stroopsToXlm(feeStroops) < threshold) {
    throw new RelayerError(
      "RELAYER_RESERVE_LOW",
      503,
      `Relayer reserve below threshold (${relayerReserveXlm} XLM, need ${threshold} XLM)`,
      true,
    );
  }
}

// ── In-memory metrics ─────────────────────────────────────────────────────

export interface HistogramSnapshot {
  count: number;
  sum: number;
  max: number;
  buckets: Record<string, number>;
}

export interface RelayerSponsorshipMetrics {
  sponsoredVotesTotal: number;
  sponsoredFeeSpendStroops: number;
  sponsoredFeeSpendXlm: number;
  authorizationRejections: Record<RelayerRejectionCode, number>;
  budgetExhaustions: number;
  nonceReplays: number;
  reserveLowRejections: number;
  rateLimitRejections: number;
  submissionFailures: number;
  feeEstimateStroopsHistogram: HistogramSnapshot;
  submissionDurationMsHistogram: HistogramSnapshot;
}

const FEE_BUCKETS = [10_000, 50_000, 100_000, 250_000, 500_000];
const DURATION_BUCKETS = [50, 200, 1_000, 5_000, 30_000];

class Histogram {
  private count = 0;
  private sum = 0;
  private max = 0;
  private readonly buckets: number[];

  constructor(private readonly bounds: number[]) {
    this.buckets = bounds.map(() => 0);
  }

  observe(value: number): void {
    if (!Number.isFinite(value)) return;
    this.count++;
    this.sum += value;
    this.max = Math.max(this.max, value);
    this.bounds.forEach((bound, i) => {
      if (value <= bound) this.buckets[i]++;
    });
  }

  snapshot(): HistogramSnapshot {
    const result: Record<string, number> = {};
    this.bounds.forEach((bound, i) => {
      result[`le_${bound}`] = this.buckets[i];
    });
    return { count: this.count, sum: this.sum, max: this.max, buckets: result };
  }

  reset(): void {
    this.count = 0;
    this.sum = 0;
    this.max = 0;
    this.buckets.fill(0);
  }
}

const feeHistogram = new Histogram(FEE_BUCKETS);
const durationHistogram = new Histogram(DURATION_BUCKETS);

function emptyRejections(): Record<RelayerRejectionCode, number> {
  const out = {} as Record<RelayerRejectionCode, number>;
  for (const code of RELAYER_REJECTION_CODES) out[code] = 0;
  return out;
}

type MetricsState = Omit<
  RelayerSponsorshipMetrics,
  "feeEstimateStroopsHistogram" | "submissionDurationMsHistogram"
>;

const metrics: MetricsState = {
  sponsoredVotesTotal: 0,
  sponsoredFeeSpendStroops: 0,
  sponsoredFeeSpendXlm: 0,
  authorizationRejections: emptyRejections(),
  budgetExhaustions: 0,
  nonceReplays: 0,
  reserveLowRejections: 0,
  rateLimitRejections: 0,
  submissionFailures: 0,
};

export function recordFeeEstimate(stroops: number): void {
  feeHistogram.observe(stroops);
}

export function recordRejection(code: RelayerRejectionCode): void {
  if (code in metrics.authorizationRejections) {
    metrics.authorizationRejections[code]++;
  }
  if (code === "BUDGET_EXHAUSTED") metrics.budgetExhaustions++;
  if (code === "NONCE_REPLAY") metrics.nonceReplays++;
  if (code === "RELAYER_RESERVE_LOW") metrics.reserveLowRejections++;
  if (code === "RATE_LIMITED") metrics.rateLimitRejections++;
}

export function recordSponsoredVote(
  feeStroops: number,
  durationMs = 0,
): void {
  metrics.sponsoredVotesTotal++;
  metrics.sponsoredFeeSpendStroops += feeStroops;
  metrics.sponsoredFeeSpendXlm = stroopsToXlm(metrics.sponsoredFeeSpendStroops);
  durationHistogram.observe(durationMs);
}

export function recordSubmissionFailure(): void {
  metrics.submissionFailures++;
}

export function getMetrics(): RelayerSponsorshipMetrics {
  return {
    ...metrics,
    authorizationRejections: { ...metrics.authorizationRejections },
    feeEstimateStroopsHistogram: feeHistogram.snapshot(),
    submissionDurationMsHistogram: durationHistogram.snapshot(),
  };
}

/** Alias kept explicit so route code reads `getRelayerSponsorshipMetrics()`. */
export const getRelayerSponsorshipMetrics = getMetrics;

export function resetRelayerSponsorshipStateForTests(): void {
  replayGuard.reset();
  tokenBucket.reset();
  sponsorshipBudget.reset();
  feeHistogram.reset();
  durationHistogram.reset();
  metrics.sponsoredVotesTotal = 0;
  metrics.sponsoredFeeSpendStroops = 0;
  metrics.sponsoredFeeSpendXlm = 0;
  metrics.authorizationRejections = emptyRejections();
  metrics.budgetExhaustions = 0;
  metrics.nonceReplays = 0;
  metrics.reserveLowRejections = 0;
  metrics.rateLimitRejections = 0;
  metrics.submissionFailures = 0;
}
