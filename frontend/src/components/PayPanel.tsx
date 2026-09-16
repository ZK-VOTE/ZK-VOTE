import { useState } from "react";
import { Button } from "./ui/Button";
import { relayerFetch } from "../lib/api";

type Asset = "XLM" | "USDC" | "EURC";

export default function PayPanel() {
  const [asset, setAsset] = useState<Asset>("XLM");
  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState("5");
  const [memo, setMemo] = useState("");
  const [loading, setLoading] = useState(false);

  const send = async () => {
    if (!dest) return alert("Destination required (G... or M...)");
    setLoading(true);
    try {
      const res = await relayerFetch("/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset, destination: dest, amount, memo }) });
      const text = await res.text();
      let j: any = {};
      try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
      alert(j.hash ? `Payment sent: ${j.hash}` : JSON.stringify(j));
    } catch (e: any) { alert(e.message); } finally { setLoading(false); }
  };

  const sendBatch = async () => {
    const ops = Array.from({ length: 3 }, (_, i) => ({ destination: dest || "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", asset, amount }));
    setLoading(true);
    try {
      const res = await relayerFetch("/pay/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ops }) });
      const text = await res.text();
      let j: any = {};
      try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
      alert(j.hash ? `Batch ${j.ops} sent: ${j.hash}` : JSON.stringify(j));
    } catch (e: any) { alert(e.message); } finally { setLoading(false); }
  };

  return (
    <div className="rounded-xl border p-6 bg-card space-y-4">
      <h3 className="text-lg font-semibold">Pay XLM / USDC / EURC (real, high-volume)</h3>
      <div className="grid grid-cols-2 gap-3">
        <select value={asset} onChange={e => setAsset(e.target.value as Asset)} className="border rounded px-3 py-2 bg-background">
          <option>XLM</option><option>USDC</option><option>EURC</option>
        </select>
        <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="Amount (7 decimals)" className="border rounded px-3 py-2 bg-background" />
      </div>
      <input value={dest} onChange={e => setDest(e.target.value)} placeholder="Destination G... or M... (muxed for inflow)" className="w-full border rounded px-3 py-2 bg-background font-mono text-sm" />
      <input value={memo} onChange={e => setMemo(e.target.value)} placeholder="Memo (optional)" className="w-full border rounded px-3 py-2 bg-background" />
      <div className="flex gap-2">
        <Button onClick={send} disabled={loading} className="flex-1">{loading ? "..." : "Send (withSequenceLock)"}</Button>
        <Button onClick={sendBatch} disabled={loading} variant="outline" className="flex-1">Batch 3× (100/tx)</Button>
      </div>
      <p className="text-xs text-muted-foreground">Muxed M... for inflow, 100 ops/tx, fee-bump, idempotency via payment_jobs.</p>
    </div>
  );
}
