// @ts-nocheck
import { Router } from "express";
import { sendPayment, sendBatch } from "../services/payments.js";
import { bodyLimit, queryLimiter } from "../middleware/index.js";
import { log } from "../services/logger.js";

console.error("PAY ROUTES LOADED", new Date().toISOString());
log("info", "pay_routes_loaded", {});

const router = Router();

router.post("/pay", bodyLimit("5kb"), async (req, res) => {
  console.error("PAY HANDLER CALLED", JSON.stringify(req.body).slice(0,100));
  log("info", "pay_hit", { body: req.body });
  try {
    const { asset, destination, amount, memo } = req.body;
    if (!asset || !destination || !amount) return res.status(400).json({ error: "asset, destination, amount required" });
    const r = await sendPayment({ asset, destination, amount, memo });
    res.json(r);
  } catch (e: any) {
    console.error("PAY ERR", e.message, e.stack?.slice(0,500));
    res.status(500).json({ error: e.message });
  }
});

router.post("/pay/batch", bodyLimit("256kb"), async (req, res) => {
  try {
    const { ops } = req.body;
    if (!Array.isArray(ops)) return res.status(400).json({ error: "ops array required" });
    const r = await sendBatch(ops);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
