/**
 * Swap Service — XLM <-> USDC/EURC via Horizon + Soroswap (real, no mock)
 */
import { quoteStrictSend, swapStrictSend, type PaymentAsset } from "./payments.js";
import { log } from "./logger.js";
import { config } from "../config.js";
import { soroswap_phishing_rejection_total } from "./metrics.js";

export type SwapPair = `${PaymentAsset}/${PaymentAsset}`;

export async function getQuote(sendAsset: PaymentAsset, destAsset: PaymentAsset, amount: string) {
  try {
    const q = await quoteStrictSend(sendAsset, amount, destAsset);
    log("info", "swap_quote", { sendAsset, destAsset, amount, destAmount: q.destAmount, source: "horizon" });
    return q;
  } catch (error) {
    const fallback = await getSoroswapQuote(sendAsset, destAsset, amount);
    if (!fallback) throw error;
    return fallback;
  }
}

export async function executeSwap(sendAsset: PaymentAsset, destAsset: PaymentAsset, sendAmount: string, destMin: string, destination: string) {
  return swapStrictSend(sendAsset, destAsset, sendAmount, destMin, destination);
}

// Soroswap fallback (if Horizon path empty, try Soroswap API when configured)
export async function getSoroswapQuote(sendAsset: PaymentAsset, destAsset: PaymentAsset, amount: string): Promise<{ destAmount: string; contractId: string } | null> {
  const url = config.soroswapApi;
  const expectedContractId = config.soroswapContractId;
  if (!expectedContractId) {
    log("warn", "soroswap_quote_disabled", { reason: "SOROSWAP_CONTRACT_ID is not configured" });
    return null;
  }
  try {
    const res = await fetch(`${url}?from=${sendAsset}&to=${destAsset}&amount=${amount}`);
    if (!res.ok) return null;
    const j: any = await res.json();
    const contractId = j.contractId || j.contract_id || j.routerContractId;
    if (contractId !== expectedContractId || typeof (j.amountOut || j.destAmount) !== "string") {
      soroswap_phishing_rejection_total.inc();
      log("error", "soroswap_quote_rejected", { reason: "contract_id_mismatch" });
      return null;
    }
    return { destAmount: j.amountOut || j.destAmount, contractId };
  } catch { return null; }
}
