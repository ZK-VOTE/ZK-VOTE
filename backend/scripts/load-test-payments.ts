/**
 * Load test 1k payments/min — XLM/USDC/EURC via batch 100 ops/tx
 * Usage: npx tsx scripts/load-test-payments.ts
 */
import { sendBatch } from "../src/services/payments.js";

const TARGET_PER_MIN = 1000;
const BATCH_SIZE = 100;
const BATCHES = Math.ceil(TARGET_PER_MIN / BATCH_SIZE); // 10
const INTERVAL_MS = 60000 / BATCHES; // 6s

async function run() {
  console.log(`Load test: ${TARGET_PER_MIN} payments/min = ${BATCHES} batches of ${BATCH_SIZE} every ${INTERVAL_MS}ms`);
  const start = Date.now();
  let total = 0;
  let ok = 0;
  let fail = 0;
  for (let b = 0; b < BATCHES; b++) {
    const ops = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      destination: `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`, // burn, use muxed in prod
      asset: (["XLM", "USDC", "EURC"] as const)[i % 3],
      amount: "0.0000001",
    }));
    const t0 = Date.now();
    try {
      const r = await sendBatch(ops as any);
      ok += ops.length;
      console.log(`Batch ${b + 1}/${BATCHES} ok ${r.hash} ${Date.now() - t0}ms`);
    } catch (e: any) {
      fail += ops.length;
      console.error(`Batch ${b + 1} fail:`, e.message?.slice(0, 200));
    }
    total += ops.length;
    if (b < BATCHES - 1) await new Promise(r => setTimeout(r, INTERVAL_MS - (Date.now() - t0)));
  }
  const elapsed = (Date.now() - start) / 1000;
  console.log(`Done: total=${total} ok=${ok} fail=${fail} elapsed=${elapsed.toFixed(1)}s rate=${(total / elapsed * 60).toFixed(0)}/min`);
  // Verify health /metrics
  try {
    const h = await fetch("http://localhost:3001/health").then(r => r.json());
    console.log("health:", h.status, "services", h.services?.status);
    const m = await fetch("http://localhost:3001/metrics").then(r => r.text());
    console.log("metrics lines:", m.split("\n").filter(l => l.startsWith("zkvote_")).length);
  } catch (e: any) {
    console.warn("health/metrics check failed:", e.message);
  }
  // Confirmation queue depth
  try {
    const q = await fetch("http://localhost:3001/tx/stats").then(r => r.json()).catch(() => ({}));
    console.log("tx/stats:", JSON.stringify(q).slice(0, 200));
  } catch {}
}

run().catch(e => { console.error(e); process.exit(1); });
