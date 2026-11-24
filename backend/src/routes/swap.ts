// @ts-nocheck
import { Router } from "express";
import { getQuote, executeSwap } from "../services/swap.js";
import { canonicalizeStellarAmount, parseStroops, formatStroops } from "../utils/stellarAmount.js";
import { signSwapQuote, verifySwapQuote } from "../services/swap-quote-integrity.js";
import {
  queryLimiter,
  bodyLimit,
  csrfOriginGuard,
  masterKeyGuard,
} from "../middleware/index.js";
import { z } from "zod";

import { stellarDestinationSchema } from "../validation/schemas.js";

const router = Router();

const assetSchema = z.enum(["XLM", "USDC", "EURC"]);
const stellarAmountSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)(?:\.\d{1,7})?$/,
    "amount must use at most 7 decimal places",
  );
const positiveStellarAmountSchema = stellarAmountSchema.refine(
  (amount) => /[1-9]/.test(amount),
  "amount must be greater than zero",
);
const swapPairFields = {
  from: assetSchema,
  to: assetSchema,
  amount: positiveStellarAmountSchema,
};
const distinctAssets = ({ from, to }: { from: string; to: string }) =>
  from !== to;
const swapPairSchema = z.object(swapPairFields).refine(distinctAssets, {
  message: "from and to must be distinct assets",
});
const swapSubmitSchema = z
  .object({
    ...swapPairFields,
    destMin: stellarAmountSchema.optional(),
    quoteToken: z.string().min(10).max(2048),
    destination: stellarDestinationSchema.optional(),
  })
  .refine(distinctAssets, {
    message: "from and to must be distinct assets",
  });

router.get("/swap/quote", queryLimiter, async (req, res) => {
  const parsed = swapPairSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message });
  }
  try {
    const { from, to, amount } = parsed.data;
    const canonicalAmount = canonicalizeStellarAmount(String(amount));
    const q = await getQuote(from, to, canonicalAmount);
    const executable = q.source === "horizon";
    res.json({
      ...q,
      executable,
      ...(executable ? { quoteToken: signSwapQuote({ from, to, amount: canonicalAmount, destAmount: q.destAmount, source: "horizon" }) } : {}),
    });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

router.post(
  "/swap/submit",
  masterKeyGuard,
  csrfOriginGuard,
  bodyLimit("5kb"),
  async (req, res) => {
    const parsed = swapSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }
    try {
      const { from, to, amount, destMin, destination, quoteToken } = parsed.data;
      const canonicalAmount = canonicalizeStellarAmount(String(amount));
      let oldQuote;
      try {
        oldQuote = verifySwapQuote(quoteToken, from, to, canonicalAmount);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
      // Maximum 1% deterioration relative to the originally displayed quote.
      const floor = parseStroops(oldQuote.destAmount) * 99n / 100n;
      if (floor === 0n) {
        return res.status(400).json({ error: "Swap quote is too small for safe slippage protection" });
      }
      const userMin = destMin ? parseStroops(destMin, true) : floor;
      if (userMin < floor) {
        return res.status(400).json({ error: "Minimum received is below the allowed 1% slippage floor" });
      }
      const freshQuote = await getQuote(from, to, canonicalAmount);
      if (freshQuote.source !== "horizon" || parseStroops(freshQuote.destAmount) < userMin) {
        return res.status(409).json({ error: "Quote drifted beyond tolerance; request a fresh quote" });
      }
      const canonicalDestMin = formatStroops(userMin);
      const dest =
        destination ||
        (await import("../services/stellar.js")).relayerKeypair.publicKey();
      const r = await executeSwap(
        from,
        to,
        canonicalAmount,
        canonicalDestMin,
        dest,
      );
      res.json(r);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  },
);

export default router;
