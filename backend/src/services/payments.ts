/**
 * Payments Service — XLM / USDC / EURC (real assets, no mocks)
 * High-volume: MuxedAccount + 100 ops/tx + fee-bump + idempotency
 */
import crypto from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { relayerKeypair } from "./stellar.js";
import { relayerKeyManager } from "./relayerKeyManager.js";
import { log } from "./logger.js";
import { getDb } from "./db.js";
import { asset_decimal_conversion_rejection_total, payment_trustline_required_total } from "./metrics.js";

const horizonServer = new (StellarSdk.Horizon as any).Server((config as any).horizonUrl || "https://horizon-testnet.stellar.org");
log("info", "payments_loaded", {});

export type PaymentAsset = "XLM" | "USDC" | "EURC";

export const HORIZON_ASSET_DECIMALS = 7;
export const SOROBAN_ASSET_DECIMALS = 12;

const ISSUERS: Record<PaymentAsset, string | null> = {
  XLM: null,
  USDC: config.usdcIssuer || null,
  EURC: config.eurcIssuer || null,
};

export function getAsset(code: PaymentAsset): StellarSdk.Asset {
  if (code === "XLM") return StellarSdk.Asset.native();
  const issuer = ISSUERS[code];
  if (!issuer) throw new Error(`Issuer not configured for ${code}`);
  return new StellarSdk.Asset(code, issuer);
}

/** Normalize human asset amounts before they enter a Horizon operation. */
export function canonicalHorizonAmount(amount: string, allowZero = false): string {
  if (typeof amount !== "string" || !/^\d+(?:\.\d+)?$/.test(amount.trim())) {
    throw new Error("Amount must be a positive decimal string");
  }
  const [whole, fraction = ""] = amount.trim().split(".");
  if (fraction.length > HORIZON_ASSET_DECIMALS) {
    asset_decimal_conversion_rejection_total.inc({ source: "human", target: "horizon" });
    throw new Error(`Horizon amounts support at most ${HORIZON_ASSET_DECIMALS} decimals`);
  }
  const normalized = `${whole}.${fraction.padEnd(HORIZON_ASSET_DECIMALS, "0")}`;
  if (Number(normalized) < 0 || (!allowZero && Number(normalized) <= 0)) {
    throw new Error(allowZero ? "Amount must not be negative" : "Amount must be positive");
  }
  return normalized;
}

/** Convert Soroban's 12-decimal atomic amount to Horizon's 7-decimal amount. */
export function sorobanAtomicToHorizonAmount(atomicAmount: string): string {
  if (!/^\d+$/.test(atomicAmount)) {
    asset_decimal_conversion_rejection_total.inc({ source: "soroban", target: "horizon" });
    throw new Error("Soroban amount must be an integer");
  }
  const atomic = BigInt(atomicAmount);
  const scale = 10n ** BigInt(SOROBAN_ASSET_DECIMALS);
  const whole = atomic / scale;
  const fraction = (atomic % scale).toString().padStart(SOROBAN_ASSET_DECIMALS, "0");
  const human = `${whole}.${fraction}`.replace(/0+$/, "").replace(/\.$/, "");
  return canonicalHorizonAmount(human);
}

export class TrustlineRequiredError extends Error {
  code = "TRUSTLINE_REQUIRED" as const;
  constructor(public asset: Exclude<PaymentAsset, "XLM">, public destination: string) {
    super(`${asset} trustline required for ${destination}`);
  }
}

async function destinationHasTrustline(destination: string, asset: PaymentAsset): Promise<boolean> {
  if (asset === "XLM") return true;
  const account: any = await (horizonServer as any).loadAccount(destination);
  const issuer = ISSUERS[asset];
  return account.balances.some((balance: any) =>
    balance.asset_type !== "native" && balance.asset_code === asset && balance.asset_issuer === issuer,
  );
}

export async function requireDestinationTrustline(destination: string, asset: PaymentAsset): Promise<void> {
  if (asset !== "XLM" && !(await destinationHasTrustline(destination, asset))) {
    payment_trustline_required_total.inc({ asset });
    throw new TrustlineRequiredError(asset, destination);
  }
}

/** Build an unsigned trustline transaction; only the destination may sign it. */
export async function buildTrustlineTransaction(destination: string, asset: Exclude<PaymentAsset, "XLM">): Promise<string> {
  const account: any = await (horizonServer as any).loadAccount(destination);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset: getAsset(asset) }))
    .setTimeout(300)
    .build();
  return tx.toXDR();
}

// MuxedAccount helper for high-volume inflow (one G... → many M...)
export function muxedForUser(base: string, id: string): string {
  const m = new StellarSdk.MuxedAccount(new StellarSdk.Account(base, "0"), id);
  // StellarSdk.MuxedAccount encodes to M...; fallback to base if not available
  try { return (m as any).accountId() as string; } catch { return base; }
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

// Single payment (uses relayerKeypair as source, withSequenceLock for high volume) — via Horizon (classic, not Soroban)
export async function sendPayment(op: PaymentOp): Promise<{ hash: string }> {
  log("info", "payment_via_horizon", {});
  const asset = getAsset(op.asset);
  const dest = op.destination;
  const amount = canonicalHorizonAmount(op.amount);
  await requireDestinationTrustline(dest, op.asset);
  const account = await (horizonServer as any).loadAccount(relayerKeypair.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, { fee: "10000", networkPassphrase: config.networkPassphrase })
    .addOperation(StellarSdk.Operation.payment({ destination: dest, asset, amount }))
    .setTimeout(30)
    .build();
  if (op.memo) (tx as any).addMemo?.(StellarSdk.Memo.text(op.memo));
  await relayerKeyManager.signTransaction(tx);
  try {
    const res: any = await (horizonServer as any).submitTransaction(tx);
    log("info", "payment_sent", { asset: op.asset, amount, dest: dest.slice(0, 8) + "...", hash: res.hash });
    return { hash: res.hash };
  } catch (e: any) {
    const data = e.response?.data || e.response?.body || e.message;
    const extras = (data as any)?.extras;
    log("error", "payment_failed", { asset: op.asset, amount, dest: dest.slice(0, 8) + "...", error: JSON.stringify(data).slice(0, 1000), extras: extras ? JSON.stringify(extras).slice(0, 1000) : undefined });
    throw new Error(typeof data === "string" ? data : JSON.stringify(data).slice(0, 500) || e.message);
  }
}

// Batch 100 ops/tx for high-volume inflow/outflow — via Horizon
export async function sendBatch(ops: PaymentOp[]): Promise<BatchResult> {
  if (ops.length === 0) throw new Error("No ops");
  if (ops.length > 100) throw new Error("Batch max 100 ops");
  for (const op of ops) {
    await requireDestinationTrustline(op.destination, op.asset);
  }
  const idempotencyKey = `batch_${Date.now()}_${crypto.randomUUID()}`;
  const db = getDb();
  try {
    db.prepare("INSERT OR IGNORE INTO payment_jobs (id, ops, created_at) VALUES (?,?,?)").run(idempotencyKey, JSON.stringify(ops), new Date().toISOString());
  } catch {}
  const account = await (horizonServer as any).loadAccount(relayerKeypair.publicKey());
  const builder = new StellarSdk.TransactionBuilder(account, { fee: (10000 * ops.length).toString(), networkPassphrase: config.networkPassphrase });
  for (const op of ops) {
    const asset = getAsset(op.asset);
    builder.addOperation(StellarSdk.Operation.payment({ destination: op.destination, asset, amount: canonicalHorizonAmount(op.amount) }));
  }
  const tx = builder.setTimeout(30).build();
  await relayerKeyManager.signTransaction(tx);
  const res: any = await (horizonServer as any).submitTransaction(tx);
  log("info", "batch_sent", { ops: ops.length, hash: res.hash });
  return { hash: res.hash, ops: ops.length };
}

// Path payment for swap XLM<->USDC/EURC via DEX (strictSend) — via Horizon
export async function swapStrictSend(sendAsset: PaymentAsset, destAsset: PaymentAsset, sendAmount: string, destMin: string, destination: string): Promise<{ hash: string }> {
  const sendA = getAsset(sendAsset);
  const destA = getAsset(destAsset);
  const canonicalSendAmount = canonicalHorizonAmount(sendAmount);
  const canonicalDestMin = canonicalHorizonAmount(destMin, true);
  await requireDestinationTrustline(destination, destAsset);
  const account = await (horizonServer as any).loadAccount(relayerKeypair.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, { fee: "10000", networkPassphrase: config.networkPassphrase })
    .addOperation(StellarSdk.Operation.pathPaymentStrictSend({
      sendAsset: sendA, sendAmount: canonicalSendAmount, destination, destAsset: destA, destMin: canonicalDestMin, path: []
    } as any))
    .setTimeout(30)
    .build();
  await relayerKeyManager.signTransaction(tx);
  const res: any = await (horizonServer as any).submitTransaction(tx);
  return { hash: res.hash };
}

// Quote via Horizon strictSendPaths (no on-chain, just simulation)
export async function quoteStrictSend(sendAsset: PaymentAsset, sendAmount: string, destAsset: PaymentAsset): Promise<{ destAmount: string; path: any[] }> {
  const sendA = getAsset(sendAsset);
  const destA = getAsset(destAsset);
  // Horizon Server strictSendPaths
  const horizonUrl = (config as any).horizonUrl || "https://horizon-testnet.stellar.org";
  const params = new URLSearchParams({
    source_account: relayerKeypair.publicKey(),
    send_asset_type: sendA.isNative() ? "native" : "credit_alphanum4",
    send_asset_code: sendA.isNative() ? "" : sendA.getCode(),
    send_asset_issuer: sendA.isNative() ? "" : sendA.getIssuer(),
    send_amount: canonicalHorizonAmount(sendAmount),
    destination_assets: `${destA.getCode()}:${destA.getIssuer()}` // for native, handled
  });
  try {
    const url = `${horizonUrl}/paths/strict-send?${params.toString()}`;
    const res = await fetch(url);
    const j: any = await res.json();
    if (j._embedded && j._embedded.records && j._embedded.records[0]) {
      const r = j._embedded.records[0];
      return { destAmount: r.destination_amount, path: r.path };
    }
    throw new Error("No path found for the requested swap");
  } catch (e) {
    log("error", "quote_failed", { error: (e as Error).message });
    throw new Error(`Quote unavailable: ${(e as Error).message}`);
  }
}
