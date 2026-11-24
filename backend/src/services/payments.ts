/**
 * Payments Service — XLM / USDC / EURC (real assets, no mocks)
 * High-volume: MuxedAccount + 100 ops/tx + fee-bump + idempotency
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { relayerKeypair, withPaymentSequenceLock } from "./stellar.js";
import { relayerKeyManager } from "./relayerKeyManager.js";
import { log } from "./logger.js";
import { getDb } from "./db.js";
import {
  sponsorshipReserveDepletedTotal,
  sponsorshipReserveXlm as sponsorshipReserveGauge,
  trustlinePreflightFailureTotal,
} from "./metrics.js";
import {
  createEndpointPool,
  HttpStatusError,
  parseRetryAfterMs,
  poolOptionsFromConfig,
  type OperationClass,
  type ProbeResult,
} from "./endpoint-pool.js";
import {
  canonicalizeStellarAmount,
  horizonStroopsToSorobanAmount,
  parseStroops,
} from "../utils/stellarAmount.js";
import {
  estimateFee,
  recordTransactionFee,
  assessRelayerReserve,
  shouldThrottleOperations,
} from "./relayer-fee-economics.js";

// ── Horizon endpoint pool (#745) ─────────────────────────────────────────
//
// HORIZON_URL / HORIZON_URLS form one pool. Per-operation rules come from
// FALLBACK_MATRIX: trustline lookups are plain reads, the relayer account
// load that supplies a sequence number is a consistent read (fresh endpoints
// only), quotes must be fresh, and submissions resend the same signed
// envelope (hash-idempotent) to another endpoint on failure.

function horizonRoot(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Horizon's root reports the ledger it serves and how far ingestion trails core. */
export async function probeHorizon(url: string): Promise<ProbeResult> {
  const res = await fetch(horizonRoot(url));
  if (!res.ok) {
    throw new HttpStatusError(res.status, `Horizon root returned HTTP ${res.status}`);
  }
  const body: any = await res.json();
  const history = Number(body.history_latest_ledger);
  const core = Number(body.core_latest_ledger);
  if (!Number.isFinite(history)) throw new Error("Horizon root missing history_latest_ledger");
  return {
    ledger: history,
    ingestLagLedgers: Number.isFinite(core) ? Math.max(0, core - history) : 0,
  };
}

export const horizonPool = createEndpointPool({
  dependency: "horizon",
  serviceName: "horizon",
  urls: config.horizonUrls,
  clientFactory: (url) => new (StellarSdk.Horizon as any).Server(url),
  probe: (_client, url) => probeHorizon(url),
  ...poolOptionsFromConfig(config),
});
log("info", "payments_loaded", { horizonEndpoints: horizonPool.urls.length });

function loadAccount(accountId: string, opClass: OperationClass = "read"): Promise<any> {
  return horizonPool.execute(opClass, (server: any) => server.loadAccount(accountId));
}

/**
 * Submit a signed envelope through the pool. If every attempt failed, check
 * whether an earlier ambiguous attempt (timeout / 504) actually landed before
 * reporting failure: a resend to a second endpoint then returns tx_bad_seq,
 * and surfacing that as a failure would invite the caller to pay twice.
 */
async function submitToHorizon(tx: StellarSdk.Transaction): Promise<any> {
  try {
    return await horizonPool.execute("submit_idempotent", (server: any) =>
      server.submitTransaction(tx),
    );
  } catch (err) {
    const hash = tx.hash().toString("hex");
    const landed: any = await horizonPool
      .execute("read", (server: any) =>
        server.transactions().transaction(hash).call(),
      )
      .catch(() => null);
    if (landed?.successful) {
      log("warn", "horizon_submit_recovered_landed_tx", { hash });
      return landed;
    }
    throw err;
  }
}

// ── Sponsorship reserve (#540) ───────────────────────────────────────────
// Each sponsored claimable-balance / M... destination locks 0.5 XLM reserve on
// the sponsor account until claimed or reclaimed.
export const CLAIMABLE_BALANCE_RESERVE_XLM = 0.5;
export const MAX_MUXED_DESTINATIONS_PER_BATCH = 100;

let sponsorshipReserveXlm = 0;

export function getSponsorshipReserveXlm(): number {
  return sponsorshipReserveXlm;
}

export function resetSponsorshipReserveForTests(): void {
  sponsorshipReserveXlm = 0;
}

/** Pre-flight reserve check: sponsor must cover locked reserves + batch fees. */
export async function checkSponsorshipReserve(newSponsorships: number): Promise<void> {
  sponsorshipReserveGauge.set(sponsorshipReserveXlm);
  if (newSponsorships === 0) return;
  const account: any = await loadAccount(relayerKeypair.publicKey()).catch(() => null);
  const native = account?.balances?.find((b: any) => b.asset_type === "native");
  const available = native
    ? parseFloat(native.balance) - parseFloat(native.selling_liabilities || "0")
    : Number.MAX_SAFE_INTEGER;
  const required = newSponsorships * CLAIMABLE_BALANCE_RESERVE_XLM;
  if (available < sponsorshipReserveXlm + required + 1) {
    sponsorshipReserveDepletedTotal.inc();
    throw new Error(
      `Insufficient sponsorship reserve: have ${available} XLM, locked ${sponsorshipReserveXlm} XLM, need +${required} XLM`,
    );
  }
}

export function noteSponsorshipCreated(count = 1): void {
  sponsorshipReserveXlm += count * CLAIMABLE_BALANCE_RESERVE_XLM;
  sponsorshipReserveGauge.set(sponsorshipReserveXlm);
}

export function noteSponsorshipReleased(count = 1): void {
  sponsorshipReserveXlm = Math.max(
    0,
    sponsorshipReserveXlm - count * CLAIMABLE_BALANCE_RESERVE_XLM,
  );
  sponsorshipReserveGauge.set(sponsorshipReserveXlm);
}

export type PaymentAsset = "XLM" | "USDC" | "EURC";

// ── Asset risk registry (SPIKE-099 / #765) ───────────────────────────────
//
// Classifies supported assets by liquidity depth and counterparty exposure so
// the onboarding workflow can gate which assets appear for each risk tier and
// the compliance layer can flag high-risk routes automatically.
//
// TIER_1 — liquid, natively supported; no extra friction.
// TIER_2 — mid-depth DEX pool; warn user about slippage on large orders.
// TIER_3 — illiquid or high-counterparty-risk; require explicit confirmation
//           and block automated batch routes.

export type AssetRiskTier = "TIER_1" | "TIER_2" | "TIER_3";

export interface AssetRiskProfile {
  code: string;
  tier: AssetRiskTier;
  /** Human-readable note shown to support and compliance tooling — never the user. */
  internalNote: string;
  /** True when the asset is enabled for the automated relayer path. */
  relayerEnabled: boolean;
}

export const ASSET_RISK_REGISTRY: AssetRiskProfile[] = [
  {
    code: "XLM",
    tier: "TIER_1",
    internalNote: "Native asset; no counterparty risk; deepest liquidity.",
    relayerEnabled: true,
  },
  {
    code: "USDC",
    tier: "TIER_1",
    internalNote: "Circle-issued USDC on Stellar; high liquidity; stable.",
    relayerEnabled: true,
  },
  {
    code: "EURC",
    tier: "TIER_2",
    internalNote: "Circle-issued EURC; growing Stellar pool; slippage risk on >$50k orders.",
    relayerEnabled: true,
  },
];

export function getAssetRiskProfile(code: string): AssetRiskProfile | undefined {
  return ASSET_RISK_REGISTRY.find((p) => p.code === code);
}

export function assertRelayerEnabled(code: string): void {
  const profile = getAssetRiskProfile(code);
  if (!profile) throw new Error(`Asset ${code} is not in the supported-asset registry.`);
  if (!profile.relayerEnabled) {
    throw new Error(`Asset ${code} (${profile.tier}) is not enabled for the automated relayer path.`);
  }
}

const ISSUERS: Record<PaymentAsset, string | null> = {
  XLM: null,
  USDC: process.env.USDC_ISSUER || null,
  EURC: process.env.EURC_ISSUER || null,
};

/**
 * Resolves a Stellar Asset instance for the given asset code.
 * @param code Asset code (XLM, USDC, EURC)
 * @returns Configured StellarSdk.Asset instance
 */
export function getAsset(code: PaymentAsset): StellarSdk.Asset {
  if (code === "XLM") return StellarSdk.Asset.native();
  const issuer = ISSUERS[code];
  if (!issuer) throw new Error(`Issuer not configured for ${code}`);
  return new StellarSdk.Asset(code, issuer);
}

export interface TrustlineStatus {
  account: string;
  asset: PaymentAsset;
  issuer: string | null;
  exists: boolean;
  authorized: boolean;
  ready: boolean;
  reason?: "missing_trustline" | "issuer_authorization_required";
}

function baseAccountId(address: string): string {
  const extract = (StellarSdk as any).extractBaseAddress;
  if (typeof extract === "function") {
    try {
      return extract(address);
    } catch {
      // Fall through to Horizon validation for ordinary G... addresses.
    }
  }
  return address;
}

function findTrustline(account: any, asset: StellarSdk.Asset): any | undefined {
  if (asset.isNative()) return undefined;
  return (account.balances ?? []).find(
    (line: any) =>
      line.asset_code === asset.getCode() &&
      line.asset_issuer === asset.getIssuer(),
  );
}

export async function getTrustlineStatus(
  accountId: string,
  assetCode: PaymentAsset,
): Promise<TrustlineStatus> {
  if (assetCode === "XLM") {
    return {
      account: baseAccountId(accountId),
      asset: assetCode,
      issuer: null,
      exists: true,
      authorized: true,
      ready: true,
    };
  }

  const asset = getAsset(assetCode);
  const account = await loadAccount(baseAccountId(accountId));
  const line = findTrustline(account, asset);
  const exists = Boolean(line);
  const authorized = exists && line.is_authorized !== false;
  return {
    account: baseAccountId(accountId),
    asset: assetCode,
    issuer: asset.getIssuer(),
    exists,
    authorized,
    ready: exists && authorized,
    reason: !exists
      ? "missing_trustline"
      : !authorized
        ? "issuer_authorization_required"
        : undefined,
  };
}

async function assertDestinationTrustline(
  accountId: string,
  assetCode: PaymentAsset,
): Promise<void> {
  if (assetCode === "XLM") return;
  const status = await getTrustlineStatus(accountId, assetCode);
  if (status.ready) return;

  const reason = status.reason ?? "missing_trustline";
  trustlinePreflightFailureTotal.inc({
    asset: assetCode,
    role: "destination",
    reason,
  });
  throw new Error(
    reason === "issuer_authorization_required"
      ? `${assetCode} trustline exists but is not authorized by issuer ${status.issuer}`
      : `Destination must create a ${assetCode} trustline to issuer ${status.issuer} before payment`,
  );
}

export async function ensureRelayerTrustline(
  assetCode: PaymentAsset,
): Promise<void> {
  if (assetCode === "XLM") return;

  const relayer = relayerKeypair.publicKey();
  let status = await getTrustlineStatus(relayer, assetCode);
  if (status.ready) return;
  if (status.exists && !status.authorized) {
    trustlinePreflightFailureTotal.inc({
      asset: assetCode,
      role: "relayer",
      reason: "issuer_authorization_required",
    });
    throw new Error(`${assetCode} relayer trustline is awaiting issuer authorization`);
  }

  await withPaymentSequenceLock(async () => {
    const account = await loadAccount(relayer, "consistent_read");
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(StellarSdk.Operation.changeTrust({ asset: getAsset(assetCode) }))
      .setTimeout(30)
      .build();
    await relayerKeyManager.signTransaction(tx);
    await submitToHorizon(tx);
  });

  status = await getTrustlineStatus(relayer, assetCode);
  if (!status.ready) {
    const reason = status.reason ?? "missing_trustline";
    trustlinePreflightFailureTotal.inc({
      asset: assetCode,
      role: "relayer",
      reason,
    });
    throw new Error(`${assetCode} relayer trustline was created but is not authorized`);
  }
}

/**
 * Creates a MuxedAccount ID (M...) for user routing from a base public key and ID.
 * @param base Base public key (G...)
 * @param id Unique multiplexing sub-account ID
 * @returns Muxed account address (M...) or base key on fallback
 */
export function muxedForUser(base: string, id: string): string {
  const m = new StellarSdk.MuxedAccount(new StellarSdk.Account(base, "0"), id);
  // StellarSdk.MuxedAccount encodes to M...; fallback to base if not available
  try {
    return (m as any).accountId() as string;
  } catch {
    return base;
  }
}

export interface PaymentOp {
  destination: string; // G... or M...
  asset: PaymentAsset;
  amount: string; // "10.0000000" 7 decimals
  memo?: string;
}

export interface BatchResult {
  hash: string;
  ops: number;
}

/**
 * Submits a single payment transaction via Horizon using the relayer account.
 * @param op Payment operation specifications (destination, asset, amount, memo)
 * @returns Transaction submission hash
 */
export async function sendPayment(op: PaymentOp): Promise<{ hash: string }> {
  log("info", "payment_via_horizon", {});
  const asset = getAsset(op.asset);
  const dest = op.destination;
  const amount = canonicalizeStellarAmount(op.amount);
  if (op.asset !== "XLM") {
    await ensureRelayerTrustline(op.asset);
    await assertDestinationTrustline(dest, op.asset);
  }
  // Build + sign + submit hold the sequence lock so a concurrent payment or a
  // key rotation cannot interleave on the relayer's sequence number.
  return withPaymentSequenceLock(async () => {
    const account = await loadAccount(relayerKeypair.publicKey(), "consistent_read");
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        StellarSdk.Operation.payment({ destination: dest, asset, amount }),
      )
      .setTimeout(30)
      .build();
    if (op.memo) (tx as any).addMemo?.(StellarSdk.Memo.text(op.memo));
    await relayerKeyManager.signTransaction(tx);
    try {
      const res: any = await submitToHorizon(tx);
      log("info", "payment_sent", {
        asset: op.asset,
        amount,
        dest: dest.slice(0, 8) + "...",
        hash: res.hash,
      });
      return { hash: res.hash };
    } catch (e: any) {
      const data = e.response?.data || e.response?.body || e.message;
      const extras = (data as any)?.extras;
      log("error", "payment_failed", {
        asset: op.asset,
        amount,
        dest: dest.slice(0, 8) + "...",
        error: JSON.stringify(data).slice(0, 1000),
        extras: extras ? JSON.stringify(extras).slice(0, 1000) : undefined,
      });
      throw new Error(
        typeof data === "string"
          ? data
          : JSON.stringify(data).slice(0, 500) || e.message,
      );
    }
  });
}

/**
 * Parses a decimal string amount into integer stroops (1 unit = 10^7 stroops)
 * using string parsing and BigInt arithmetic to avoid floating-point precision drift.
 * @param amount String representation of decimal amount (e.g. "10.5000000")
 * @returns BigInt representation in stroops
 */
export function parseAmountToStroops(amount: string): bigint {
  if (!amount || typeof amount !== "string") {
    throw new Error("Invalid amount: must be a non-empty string");
  }
  return parseStroops(amount.trim());
}

/**
 * Submits a batch of payments (up to 100 ops/tx) via Horizon with tenant-scoped idempotency.
 * @param ops Array of payment operations
 * @param tenantId Tenant identifier for scoping idempotency and outbox records
 * @returns Result containing deterministic transaction hash and operation count
 */
export async function sendBatch(
  ops: PaymentOp[],
  tenantId: string = "default",
): Promise<BatchResult> {
  if (ops.length === 0) throw new Error("No ops");
  if (ops.length > 100) throw new Error("Batch max 100 ops");
  const muxedCount = ops.filter((o) => o.destination?.startsWith("M")).length;
  if (muxedCount > MAX_MUXED_DESTINATIONS_PER_BATCH) {
    throw new Error("MuxedAccount limit exceeded");
  }
  const opsJson = JSON.stringify(ops);
  const hash = StellarSdk.hash(
    Buffer.from(`${tenantId}:${opsJson}`, "utf8"),
  ).toString("hex");
  const totalAmount = ops.reduce(
    (sum, op) => sum + parseAmountToStroops(op.amount),
    0n,
  );
  const db = getDb();

  const existingJob: any = db
    .prepare("SELECT id FROM payment_jobs WHERE id = ?")
    .get(hash);
  if (existingJob) {
    log("info", "batch_payment_idempotent_hit", {
      hash,
      tenantId,
      ops: ops.length,
    });
    return { hash, ops: ops.length };
  }

  // Validate every credit-asset trustline before persisting idempotency state.
  // A rejected preflight must remain retryable and must not look completed.
  const creditAssets = Array.from(
    new Set(ops.map((op) => op.asset).filter((asset) => asset !== "XLM")),
  ) as PaymentAsset[];
  for (const assetCode of creditAssets) {
    await ensureRelayerTrustline(assetCode);
  }
  for (const op of ops) {
    if (op.asset !== "XLM") {
      await assertDestinationTrustline(op.destination, op.asset);
    }
  }
  await checkSponsorshipReserve(muxedCount);

  try {
    db.prepare(
      "INSERT INTO payment_jobs (id, tenant_id, amount, ops, created_at) VALUES (?,?,?,?,?)",
    ).run(
      hash,
      tenantId,
      totalAmount.toString(),
      opsJson,
      new Date().toISOString(),
    );
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint failed")) {
      return { hash, ops: ops.length };
    }
    throw err;
  }

  // SPIKE-760: Reserve defense + surge-aware fee estimation
  const relayerAccount = await loadAccount(relayerKeypair.publicKey(), "consistent_read");
  const relayerBalance = parseFloat(
    relayerAccount.balances.find((b: any) => b.asset_type === "native")?.balance || "0",
  );

  const reserveStatus = await assessRelayerReserve(
    relayerBalance,
    sponsorshipReserveXlm,
    0.1,
  );

  const feeEstimate = await estimateFee(ops.length, relayerBalance, muxedCount);

  if (await shouldThrottleOperations(reserveStatus, feeEstimate)) {
    throw new Error(
      `Batch rejected: ${reserveStatus.status} reserve (${relayerBalance.toFixed(2)} XLM) + ${feeEstimate.networkStatus} network. Try again with fewer ops or higher batch size for better fees.`,
    );
  }

  // The whole batch build + sign + submit holds the sequence lock.
  return withPaymentSequenceLock(async () => {
    const account = await loadAccount(relayerKeypair.publicKey(), "consistent_read");
    const builder = new StellarSdk.TransactionBuilder(account, {
      fee: feeEstimate.recommendedForOps.toString(),
      networkPassphrase: config.networkPassphrase,
    });
    for (const op of ops) {
      const asset = getAsset(op.asset);
      builder.addOperation(
        StellarSdk.Operation.payment({
          destination: op.destination,
          asset,
          amount: canonicalizeStellarAmount(op.amount),
        }),
      );
    }
    const tx = builder.setTimeout(30).build();
    await relayerKeyManager.signTransaction(tx);
    const res: any = await submitToHorizon(tx);
    log("info", "batch_sent", {
      ops: ops.length,
      hash: res.hash,
      feePerOp: feeEstimate.baseFee,
      surgeMultiplier: feeEstimate.surgeMultiplier,
      reserveStatus: reserveStatus.status,
    });

    // Record fee for historical tracking
    await recordTransactionFee(
      res.hash,
      feeEstimate.baseFee,
      ops.length,
      feeEstimate.recommendedForOps,
    );

    if (muxedCount > 0) noteSponsorshipCreated(muxedCount);
    return { hash: res.hash, ops: ops.length };
  });
}

/**
 * Executes a path payment to swap assets via Stellar DEX using strictSend.
 * @param sendAsset Asset to send
 * @param destAsset Destination asset to receive
 * @param sendAmount Exact amount of sendAsset to spend
 * @param destMin Minimum acceptable amount of destAsset to receive (slippage limit)
 * @param destination Recipient public address
 * @returns Transaction hash of the swap
 */
export async function swapStrictSend(
  sendAsset: PaymentAsset,
  destAsset: PaymentAsset,
  sendAmount: string,
  destMin: string,
  destination: string,
): Promise<{ hash: string }> {
  if (sendAsset === destAsset) throw new Error("Swap assets must be distinct");

  // SPIKE-027: Validate slippage parameters before execution
  if (!destMin || destMin === "0") {
    throw new Error("Slippage protection required: destMin must be > 0");
  }

  const sendA = getAsset(sendAsset);
  const destA = getAsset(destAsset);
  const canonicalSendAmount = canonicalizeStellarAmount(sendAmount);
  const canonicalDestMin = canonicalizeStellarAmount(destMin, true);
  if (sendAsset !== "XLM") {
    await ensureRelayerTrustline(sendAsset);
  }
  if (destAsset !== "XLM") {
    if (baseAccountId(destination) === relayerKeypair.publicKey()) {
      await ensureRelayerTrustline(destAsset);
    } else {
      await assertDestinationTrustline(destination, destAsset);
    }
  }
  return withPaymentSequenceLock(async () => {
    const account = await loadAccount(relayerKeypair.publicKey(), "consistent_read");
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        StellarSdk.Operation.pathPaymentStrictSend({
          sendAsset: sendA,
          sendAmount: canonicalSendAmount,
          destination,
          destAsset: destA,
          destMin: canonicalDestMin,
          path: [],
        } as any),
      )
      .setTimeout(30)
      .build();
    await relayerKeyManager.signTransaction(tx);
    const res: any = await submitToHorizon(tx);
    return { hash: res.hash };
  });
  const account = await (horizonServer as any).loadAccount(
    relayerKeypair.publicKey(),
  );
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.pathPaymentStrictSend({
        sendAsset: sendA,
        sendAmount: canonicalSendAmount,
        destination,
        destAsset: destA,
        destMin: canonicalDestMin,
        path: [],
      } as any),
    )
    .setTimeout(30)
    .build();
  await relayerKeyManager.signTransaction(tx);

  // SPIKE-027: Enhanced error handling for swap failures with slippage context
  try {
    const res: any = await (horizonServer as any).submitTransaction(tx);
    log("info", "swap_executed", {
      sendAsset,
      destAsset,
      sendAmount: canonicalSendAmount,
      destMin: canonicalDestMin,
      hash: res.hash,
    });
    return { hash: res.hash };
  } catch (e: any) {
    const data = e.response?.data || e.response?.body || e.message;
    const extras = (data as any)?.extras;
    const resultCodes = extras?.result_codes;

    log("error", "swap_failed", {
      sendAsset,
      destAsset,
      sendAmount: canonicalSendAmount,
      destMin: canonicalDestMin,
      error: JSON.stringify(data).slice(0, 1000),
      resultCodes: resultCodes ? JSON.stringify(resultCodes) : undefined,
    });

    // Check if failure was due to slippage (path payment underfunded)
    const isSlippageError = resultCodes?.operations?.includes("op_under_dest_min");
    throw new Error(
      isSlippageError
        ? `Swap failed: slippage exceeded (received less than destMin ${destMin})`
        : resultCodes
          ? `Swap failed: ${JSON.stringify(resultCodes)}`
          : typeof data === "string"
            ? data
            : JSON.stringify(data).slice(0, 500) || e.message
    );
  }
}

/**
 * Queries simulated strictSend payment paths from Horizon to obtain a price quote.
 * @param sendAsset Asset to send
 * @param sendAmount Amount to send
 * @param destAsset Asset to receive
 * @returns Estimated destination amount and payment routing path
 */
export interface StrictSendQuote {
  sendAmount: string;
  sendStroops: string;
  sendSorobanAmount: string;
  destAmount: string;
  destStroops: string;
  destSorobanAmount: string;
  path: unknown[];
}
export async function quoteStrictSend(
  sendAsset: PaymentAsset,
  sendAmount: string,
  destAsset: PaymentAsset,
): Promise<StrictSendQuote> {
  if (sendAsset === destAsset) throw new Error("Swap assets must be distinct");
  const sendA = getAsset(sendAsset);
  const destA = getAsset(destAsset);
  const canonicalSendAmount = canonicalizeStellarAmount(sendAmount);
  const sendStroops = parseStroops(canonicalSendAmount);
  const params = new URLSearchParams({
    source_account: relayerKeypair.publicKey(),
    send_asset_type: sendA.isNative() ? "native" : "credit_alphanum4",
    send_asset_code: sendA.isNative() ? "" : sendA.getCode(),
    send_asset_issuer: sendA.isNative() ? "" : sendA.getIssuer(),
    send_amount: canonicalSendAmount,
    destination_assets: destA.isNative()
      ? "native"
      : `${destA.getCode()}:${destA.getIssuer()}`,
  });
  try {
    // Quotes only come from endpoints within the finality-lag bound: a
    // lagging order book yields a destMin the live book cannot honour.
    const j: any = await horizonPool.execute("quote", async (_server, { url }) => {
      const res = await fetch(
        `${horizonRoot(url)}paths/strict-send?${params.toString()}`,
      );
      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          `Horizon strict-send returned HTTP ${res.status}`,
          parseRetryAfterMs(res.headers.get("retry-after")),
        );
      }
      return res.json();
    });
    if (j._embedded && j._embedded.records && j._embedded.records[0]) {
      const r = j._embedded.records[0];
      const destStroops = parseStroops(String(r.destination_amount));
      return {
        sendAmount: canonicalSendAmount,
        sendStroops: sendStroops.toString(),
        sendSorobanAmount: horizonStroopsToSorobanAmount(sendStroops).toString(),
        destAmount: canonicalizeStellarAmount(String(r.destination_amount)),
        destStroops: destStroops.toString(),
        destSorobanAmount: horizonStroopsToSorobanAmount(destStroops).toString(),
        path: Array.isArray(r.path) ? r.path : [],
      };
    }
    throw new Error("No path found for the requested swap");
  } catch (e) {
    log("error", "quote_failed", { error: (e as Error).message });
    throw new Error(`Quote unavailable: ${(e as Error).message}`);
  }
}
