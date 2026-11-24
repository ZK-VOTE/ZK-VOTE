/**
 * Typed pay/swap API client (#597).
 *
 * Single source of truth for the PayPanel/SwapPanel wire format, mirroring
 * the backend zod schemas (validation/schemas.ts) and openapi.ts ENDPOINTS:
 * POST /pay, POST /pay/batch, GET /swap/quote, POST /swap/submit.
 * All JSON parsing is content-type aware via relayerFetch + explicit
 * res.text()→JSON with a clear 404 hint when the spec drifts from routes.
 */

import { relayerFetch } from "./api";
import { classifyStellarAddress } from "./stellar-address";

export type PaymentAsset = "XLM" | "USDC" | "EURC";

export interface PaymentOp {
  destination: string;
  asset: PaymentAsset;
  amount: string;
  memo?: string;
}

export interface PaymentResult {
  hash: string;
}

export interface BatchResult {
  hash: string;
  ops: number;
}

export interface SwapQuote {
  destAmount: string;
  path: unknown[];
}

async function parseJsonResponse(res: Response, endpoint: string): Promise<any> {
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      res.status === 404
        ? `Unknown endpoint ${endpoint} (HTTP 404) — frontend spec is stale, regenerate via npm run docs:generate`
        : `Non-JSON response from ${endpoint} (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Unknown endpoint ${endpoint} (HTTP 404) — check openapi parity`);
    }
    throw new Error(body.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return body;
}

export function assertValidPaymentOp(op: PaymentOp): void {
  if (!["XLM", "USDC", "EURC"].includes(op.asset)) throw new Error(`Invalid asset: ${op.asset}`);
  if (classifyStellarAddress(op.destination) === null) {
    throw new Error("Invalid destination: must be G... (account) or M... (muxed) — they are not interchangeable");
  }
  if (!/^\d+(\.\d{1,7})?$/.test(op.amount) || Number(op.amount) <= 0) {
    throw new Error("Invalid amount: decimal string > 0, up to 7 decimals");
  }
}

export async function sendPayment(op: PaymentOp): Promise<PaymentResult> {
  assertValidPaymentOp(op);
  const res = await relayerFetch("/pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(op),
  });
  return parseJsonResponse(res, "POST /pay");
}

export async function sendBatchPayment(ops: PaymentOp[]): Promise<BatchResult> {
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > 100) {
    throw new Error("Batch requires 1-100 ops");
  }
  ops.forEach(assertValidPaymentOp);
  const res = await relayerFetch("/pay/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops }),
  });
  return parseJsonResponse(res, "POST /pay/batch");
}

export async function fetchSwapQuote(from: PaymentAsset, to: PaymentAsset, amount: string): Promise<SwapQuote> {
  const res = await relayerFetch(`/swap/quote?from=${from}&to=${to}&amount=${encodeURIComponent(amount)}`);
  const body = await parseJsonResponse(res, "GET /swap/quote");
  return { destAmount: body.destAmount ?? body.quote ?? amount, path: body.path ?? [] };
}

export async function submitSwap(params: {
  from: PaymentAsset;
  to: PaymentAsset;
  amount: string;
  destMin?: string;
  destination?: string;
}): Promise<PaymentResult> {
  if (params.destination && classifyStellarAddress(params.destination) === null) {
    throw new Error("Invalid swap destination: must be G... or M...");
  }
  const res = await relayerFetch("/swap/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return parseJsonResponse(res, "POST /swap/submit");
}
