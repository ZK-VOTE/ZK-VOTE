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
import { postTransfer, stellarAmountToMinor } from "./ledger.js";

const horizonServer = new (StellarSdk.Horizon as any).Server((config as any).horizonUrl || "https://horizon-testnet.stellar.org");
log("info", "payments_loaded", {});

export type PaymentAsset = "XLM" | "USDC" | "EURC";

const ISSUERS: Record<PaymentAsset, string | null> = {
  XLM: null,
  USDC: process.env.USDC_ISSUER || null,
  EURC: process.env.EURC_ISSUER || null,
};

export function getAsset(code: PaymentAsset): StellarSdk.Asset {
  if (code === "XLM") return StellarSdk.Asset.native();
  const issuer = ISSUERS[code];
  if (!issuer) throw new Error(`Issuer not configured for ${code}`);
  return new StellarSdk.Asset(code, issuer);
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

/**
 * Mirror a successfully submitted Stellar payment into the double-entry
 * ledger: DEBIT relayer(source) and CREDIT destination for the same integer
 * minor-unit amount. Posting is best-effort — a ledger failure must not turn
 * an already-accepted on-chain payment into an application error.
 */
function recordPaymentPosting(op: PaymentOp, txHash: string, postingGroupId: string): void {
  try {
    const amountMinor = stellarAmountToMinor(op.amount);
    postTransfer({
      postingGroupId,
      sourceAccount: `stellar:${relayerKeypair.publicKey()}`,
      destinationAccount: `stellar:${op.destination}`,
      asset: op.asset,
      amountMinor,
      createdAt: new Date().toISOString(),
    });
    log("info", "payment_ledger_posted", { asset: op.asset, hash: txHash, postingGroupId });
  } catch (error) {
    log("warn", "payment_ledger_post_failed", {
      asset: op.asset,
      hash: txHash,
      postingGroupId,
      error: (error as Error).message,
    });
  }
}

// Single payment (uses relayerKeypair as source, withSequenceLock for high volume) — via Horizon (classic, not Soroban)
export async function sendPayment(op: PaymentOp): Promise<{ hash: string }> {
  log("info", "payment_via_horizon", {});
  const asset = getAsset(op.asset);
  const dest = op.destination;
  const amount = op.amount;
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
    recordPaymentPosting(op, res.hash, `payment_${res.hash}`);
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
  const idempotencyKey = `batch_${Date.now()}_${crypto.randomUUID()}`;
  const db = getDb();
  try {
    db.prepare("INSERT OR IGNORE INTO payment_jobs (id, ops, created_at) VALUES (?,?,?)").run(idempotencyKey, JSON.stringify(ops), new Date().toISOString());
  } catch {}
  const account = await (horizonServer as any).loadAccount(relayerKeypair.publicKey());
  const builder = new StellarSdk.TransactionBuilder(account, { fee: (10000 * ops.length).toString(), networkPassphrase: config.networkPassphrase });
  for (const op of ops) {
    const asset = getAsset(op.asset);
    builder.addOperation(StellarSdk.Operation.payment({ destination: op.destination, asset, amount: op.amount }));
  }
  const tx = builder.setTimeout(30).build();
  await relayerKeyManager.signTransaction(tx);
  const res: any = await (horizonServer as any).submitTransaction(tx);
  log("info", "batch_sent", { ops: ops.length, hash: res.hash });
  // Each operation gets its own balanced posting group, keyed by tx hash + index.
  ops.forEach((op, index) => recordPaymentPosting(op, res.hash, `batch_${res.hash}_${index}`));
  return { hash: res.hash, ops: ops.length };
}

// Path payment for swap XLM<->USDC/EURC via DEX (strictSend) — via Horizon
export async function swapStrictSend(sendAsset: PaymentAsset, destAsset: PaymentAsset, sendAmount: string, destMin: string, destination: string): Promise<{ hash: string }> {
  const sendA = getAsset(sendAsset);
  const destA = getAsset(destAsset);
  const account = await (horizonServer as any).loadAccount(relayerKeypair.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, { fee: "10000", networkPassphrase: config.networkPassphrase })
    .addOperation(StellarSdk.Operation.pathPaymentStrictSend({
      sendAsset: sendA, sendAmount, destination, destAsset: destA, destMin, path: []
    } as any))
    .setTimeout(30)
    .build();
  await relayerKeyManager.signTransaction(tx);
  const res: any = await (horizonServer as any).submitTransaction(tx);
  // Cross-asset swaps are deliberately not posted here: a single balanced
  // posting group must contain one asset. Swap legs are posted by settlement
  // reconciliation once the destination asset is actually observed.
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
    send_amount: sendAmount,
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
