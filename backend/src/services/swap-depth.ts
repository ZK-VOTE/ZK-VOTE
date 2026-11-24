/**
 * Depth-Aware Swap Service (Issue #799)
 * Provides liquidity depth checking and price impact warnings
 */

import { Horizon, SorobanRpc } from "@stellar/stellar-sdk";

export interface DepthCheck {
  fillable: boolean;
  estimatedFillPercent: number;
  priceImpactPercent: number;
  recommendedMaxAmount: string;
  warning?: string;
}

export interface SwapQuoteWithDepth {
  sourceAmount: string;
  destAmount: string;
  destMin: string;
  path: any[];
  source: "horizon" | "soroswap";
  depthCheck: DepthCheck;
}

// Asset tier configuration for position limits
const ASSET_TIERS = {
  tier1: ["XLM", "USDC", "AQUA"], // High liquidity
  tier2: ["EURC", "yUSDC"], // Medium liquidity
  tier3: [], // Low liquidity / experimental
};

const TIER_LIMITS = {
  tier1: { maxSwapUSD: 100000, priceImpactWarnPercent: 1, priceImpactBlockPercent: 5 },
  tier2: { maxSwapUSD: 10000, priceImpactWarnPercent: 0.5, priceImpactBlockPercent: 2 },
  tier3: { maxSwapUSD: 1000, priceImpactWarnPercent: 0.2, priceImpactBlockPercent: 1 },
};

export class SwapDepthService {
  private horizonServer: Horizon.Server;

  constructor(horizonUrl: string) {
    this.horizonServer = new Horizon.Server(horizonUrl);
  }

  /**
   * Determine asset tier based on liquidity
   */
  private getAssetTier(assetCode: string): keyof typeof TIER_LIMITS {
    if (ASSET_TIERS.tier1.includes(assetCode)) return "tier1";
    if (ASSET_TIERS.tier2.includes(assetCode)) return "tier2";
    return "tier3";
  }

  /**
   * Check if swap amount is within tier limits
   */
  checkPositionLimits(
    assetCode: string,
    amountUSD: number,
  ): { allowed: boolean; message?: string } {
    const tier = this.getAssetTier(assetCode);
    const limits = TIER_LIMITS[tier];

    if (amountUSD > limits.maxSwapUSD) {
      return {
        allowed: false,
        message: `Swap amount exceeds ${assetCode} tier limit of $${limits.maxSwapUSD}. Consider splitting into multiple swaps or using OTC.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Estimate order book depth for a given amount
   */
  async estimateDepth(
    sourceAsset: Horizon.Asset,
    destAsset: Horizon.Asset,
    sourceAmount: string,
  ): Promise<DepthCheck> {
    try {
      // Fetch order book
      const orderbook = await this.horizonServer
        .orderbook(sourceAsset, destAsset)
        .call();

      let remaining = parseFloat(sourceAmount);
      let totalFilled = 0;
      let avgPrice = 0;
      let initialPrice = 0;

      // Walk through bids/asks to see how much can be filled
      const offers = orderbook.asks; // For selling sourceAsset
      
      if (offers.length === 0) {
        return {
          fillable: false,
          estimatedFillPercent: 0,
          priceImpactPercent: 100,
          recommendedMaxAmount: "0",
          warning: "No liquidity available for this pair",
        };
      }

      initialPrice = parseFloat(offers[0].price);

      for (const offer of offers) {
        const offerAmount = parseFloat(offer.amount);
        const offerPrice = parseFloat(offer.price);

        if (remaining <= 0) break;

        const fillAmount = Math.min(remaining, offerAmount);
        totalFilled += fillAmount;
        avgPrice += fillAmount * offerPrice;
        remaining -= fillAmount;
      }

      const fillPercent = ((totalFilled / parseFloat(sourceAmount)) * 100);
      const executionPrice = avgPrice / totalFilled;
      const priceImpact = ((executionPrice - initialPrice) / initialPrice) * 100;

      const fillable = fillPercent > 95; // Consider fillable if >95% can be filled
      const tier = this.getAssetTier(destAsset.code);
      const limits = TIER_LIMITS[tier];

      let warning: string | undefined;
      if (priceImpact > limits.priceImpactBlockPercent) {
        warning = `Price impact ${priceImpact.toFixed(2)}% exceeds safe threshold. Swap blocked.`;
      } else if (priceImpact > limits.priceImpactWarnPercent) {
        warning = `Warning: ${priceImpact.toFixed(2)}% price impact detected. Consider reducing amount.`;
      }

      return {
        fillable,
        estimatedFillPercent: fillPercent,
        priceImpactPercent: priceImpact,
        recommendedMaxAmount: totalFilled.toString(),
        warning,
      };
    } catch (error) {
      console.error("Depth check failed:", error);
      return {
        fillable: false,
        estimatedFillPercent: 0,
        priceImpactPercent: 100,
        recommendedMaxAmount: "0",
        warning: "Unable to check liquidity depth",
      };
    }
  }

  /**
   * Get quote with depth awareness
   */
  async getQuoteWithDepth(
    sourceAsset: Horizon.Asset,
    destAsset: Horizon.Asset,
    sourceAmount: string,
  ): Promise<SwapQuoteWithDepth | null> {
    try {
      // First check depth
      const depthCheck = await this.estimateDepth(
        sourceAsset,
        destAsset,
        sourceAmount,
      );

      // Block if price impact too high
      const tier = this.getAssetTier(destAsset.code);
      if (depthCheck.priceImpactPercent > TIER_LIMITS[tier].priceImpactBlockPercent) {
        return null;
      }

      // Get actual quote from path payment
      const paths = await this.horizonServer
        .strictSendPaths(sourceAsset, sourceAmount, [destAsset])
        .call();

      if (paths.records.length === 0) {
        return null;
      }

      const bestPath = paths.records[0];

      return {
        sourceAmount: bestPath.source_amount,
        destAmount: bestPath.destination_amount,
        destMin: (parseFloat(bestPath.destination_amount) * 0.98).toString(), // 2% slippage
        path: bestPath.path,
        source: "horizon",
        depthCheck,
      };
    } catch (error) {
      console.error("Quote with depth failed:", error);
      return null;
    }
  }

  /**
   * Monitor depth degradation (for alerts)
   */
  async checkDepthDegradation(
    assetCode: string,
    thresholdPercent: number,
  ): Promise<boolean> {
    // TODO: Implement historical depth comparison
    // Compare current depth to 7-day average
    // Alert if drops below threshold
    return false;
  }
}
