// @ts-nocheck
import { Router } from "express";
import { sep6Deposit, sep6Withdraw } from "../services/anchor.js";
import { queryLimiter } from "../middleware/index.js";

const router = Router();

router.get("/ramp/deposit", queryLimiter, async (req, res) => {
  try {
    const { asset, account, amount } = req.query as any;
    if (!asset || !account || !amount) return res.status(400).json({ error: "asset, account, amount required" });
    const r = await sep6Deposit(asset, account, amount);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/ramp/withdraw", queryLimiter, async (req, res) => {
  try {
    const { asset, account, amount, dest } = req.query as any;
    if (!asset || !account || !amount) return res.status(400).json({ error: "asset, account, amount required" });
    const r = await sep6Withdraw(asset, account, amount, dest || "bank");
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
