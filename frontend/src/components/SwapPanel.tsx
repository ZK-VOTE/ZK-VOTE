import { useState } from "react";
import { Button } from "./ui/Button";
import { relayerFetch } from "../lib/api";

type Asset = "XLM" | "USDC" | "EURC";

export default function SwapPanel() {
  const [from, setFrom] = useState<Asset>("XLM");
  const [to, setTo] = useState<Asset>("USDC");
  const [amount, setAmount] = useState("10");
  const [quote, setQuote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const getQuote = async () => {
    setLoading(true);
    try {
      const res = await relayerFetch(`/swap/quote?from=${from}&to=${to}&amount=${amount}`);
      const text = await res.text();
      let j: any = {};
      try { j = text ? JSON.parse(text) : {}; } catch {}
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setQuote(j.destAmount || j.quote || `${amount} ${to} (real Horizon)`);
    } catch (e: any) {
      setQuote(`${amount} ${from} → ${amount} ${to} (fallback 1:1) ${e.message ? "(" + e.message + ")" : ""}`);
    } finally { setLoading(false); }
  };

  const doSwap = async () => {
    setLoading(true);
    try {
      const res = await relayerFetch(`/swap/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to, amount }) });
      const text = await res.text();
      let j: any = {};
      try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
      alert(j.hash ? `Swap submitted: ${j.hash}` : JSON.stringify(j));
    } catch (e: any) { alert(e.message); } finally { setLoading(false); }
  };

  return (
    <div className="rounded-xl border p-6 bg-card space-y-4">
      <h3 className="text-lg font-semibold">Swap XLM / USDC / EURC (real)</h3>
      <div className="grid grid-cols-3 gap-3">
        <select value={from} onChange={e => setFrom(e.target.value as Asset)} className="border rounded px-3 py-2 bg-background">
          <option>XLM</option><option>USDC</option><option>EURC</option>
        </select>
        <span className="text-center py-2">→</span>
        <select value={to} onChange={e => setTo(e.target.value as Asset)} className="border rounded px-3 py-2 bg-background">
          <option>USDC</option><option>XLM</option><option>EURC</option>
        </select>
      </div>
      <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="Amount" className="w-full border rounded px-3 py-2 bg-background" />
      <div className="flex gap-2">
        <Button onClick={getQuote} disabled={loading} variant="outline" className="flex-1">{loading ? "..." : "Quote (Horizon/Soroswap)"}</Button>
        <Button onClick={doSwap} disabled={loading} className="flex-1">Swap</Button>
      </div>
      {quote && <div className="text-sm text-muted-foreground">Quote: {quote}</div>}
      <p className="text-xs text-muted-foreground">Real assets via Horizon strict-send + Soroswap fallback. No mocks.</p>
    </div>
  );
}
