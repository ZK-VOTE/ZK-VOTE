// @ts-nocheck
import { Router } from "express";
import { getQuote, executeSwap } from "../services/swap.js";
import { queryLimiter, bodyLimit } from "../middleware/index.js";

const router = Router();

router.get("/swap/quote", queryLimiter, async (req, res) => {
  try {
    const { from, to, amount } = req.query as any;
    if (!from || !to || !amount) return res.status(400).json({ error: "from, to, amount required" });
    const q = await getQuote(from as any, to as any, amount as string);
    res.json(q);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/swap/submit", bodyLimit("5kb"), async (req, res) => {
  try {
    const { from, to, amount, destMin, destination } = req.body;
    const dest = destination || (await import("../services/stellar.js")).relayerKeypair.publicKey();
    const r = await executeSwap(from, to, amount, destMin || "0", dest);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
