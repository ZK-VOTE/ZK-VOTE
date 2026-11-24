/**
 * Swap Service — XLM <-> USDC/EURC via Horizon + Soroswap (real, no mock)
 */
import {
  quoteStrictSend,
  swapStrictSend,
  type PaymentAsset,
} from "./payments.js";
import { config } from "../config.js";
import { log } from "./logger.js";
import { swapContractRejectedTotal } from "./metrics.js";
import { markDegraded, markHealthy, markUnavailable } from "./service-health.js";
import {
  canonicalizeStellarAmount,
  horizonStroopsToSorobanAmount,
  parseStroops,
} from "../utils/stellarAmount.js";

export type SwapPair = `${PaymentAsset}/${PaymentAsset}`;

export async function getQuote(
  sendAsset: PaymentAsset,
  destAsset: PaymentAsset,
  amount: string,
) {
  if (sendAsset === destAsset) throw new Error("Swap assets must be distinct");
  try {
    const q = await quoteStrictSend(sendAsset, amount, destAsset);
    log("info", "swap_quote", {
      source: "horizon",
      sendAsset,
      destAsset,
      amount,
      destAmount: q.destAmount,
    });
    markHealthy("swap_quotes");
    return { ...q, source: "horizon" as const, degraded: false };
  } catch (horizonError) {
    const fallback = await getSoroswapQuote(sendAsset, destAsset, amount);
    if (fallback) {
      log("info", "swap_quote", {
        source: "soroswap",
        sendAsset,
        destAsset,
        amount,
        destAmount: fallback.destAmount,
        contractId: fallback.contractId,
      });
      // Soroswap is a quote-only fallback (#745): executeSwap still settles
      // through Horizon, so surface the degraded source to the client.
      markDegraded("swap_quotes", "serving Soroswap fallback quotes");
      return { ...fallback, path: [], source: "soroswap" as const, degraded: true };
    }
    markUnavailable("swap_quotes", (horizonError as Error).message);
    throw horizonError;
  }
}

export async function executeSwap(
  sendAsset: PaymentAsset,
  destAsset: PaymentAsset,
  sendAmount: string,
  destMin: string,
  destination: string,
) {
  if (sendAsset === destAsset) throw new Error("Swap assets must be distinct");
  return swapStrictSend(sendAsset, destAsset, sendAmount, destMin, destination);
}

// Soroswap fallback (if Horizon path empty, try Soroswap API when configured)
export async function getSoroswapQuote(
  sendAsset: PaymentAsset,
  destAsset: PaymentAsset,
  amount: string,
): Promise<{
  destAmount: string;
  destStroops: string;
  destSorobanAmount: string;
  contractId: string;
} | null> {
  const expectedContractId = (config as any).soroswapContractId as
    | string
    | undefined;
  if (!expectedContractId) {
    log("warn", "soroswap_fallback_disabled", {
      reason: "contract_id_not_pinned",
    });
    return null;
  }

  const url = (config as any).soroswapApi as string;
  try {
    const res = await fetch(
      `${url}?from=${sendAsset}&to=${destAsset}&amount=${amount}`,
      { signal: AbortSignal.timeout(config.endpointRequestTimeoutMs) },
    );
    if (!res.ok) return null;
    const j: any = await res.json();
    const returnedContractId = String(
      j.contractId ?? j.contract_id ?? j.routerContractId ?? "",
    );
    if (returnedContractId !== expectedContractId) {
      const reason = returnedContractId
        ? "contract_id_mismatch"
        : "missing_contract_id";
      swapContractRejectedTotal.inc({ reason });
      log("error", "soroswap_quote_rejected", {
        reason,
        expectedContractId,
        returnedContractId: returnedContractId || undefined,
      });
      return null;
    }

    const rawAmount = String(j.amountOut ?? j.destAmount ?? "");
    const destStroops = parseStroops(rawAmount);
    return {
      destAmount: canonicalizeStellarAmount(rawAmount),
      destStroops: destStroops.toString(),
      destSorobanAmount: horizonStroopsToSorobanAmount(destStroops).toString(),
      contractId: returnedContractId,
    };
  } catch (error) {
    log("warn", "soroswap_quote_unavailable", {
      error: (error as Error).message,
    });
    return null;
  }
}
