import { useState, useEffect } from "react";
import { Button } from "./ui/Button";
import { relayerFetch } from "../lib/api";
import { isAllowedMessageOrigin } from "../lib/messageOrigin";
import {
  canonicalizeStellarAmount,
  formatStroops,
  horizonStroopsToSorobanAmount,
  parseStroops,
} from "../lib/stellarAmount";
import {
  useOnWalletSessionChange,
  useSessionBoundForm,
} from "../hooks/useWalletSession";

type Asset = "XLM" | "USDC" | "EURC";

export default function SwapPanel() {
  const [from, setFrom] = useState<Asset>("XLM");
  const [to, setTo] = useState<Asset>("USDC");
  const [amount, setAmount] = useState("10");
  const [quote, setQuote] = useState<string | null>(null);
  const [quoteToken, setQuoteToken] = useState<string | null>(null);
  const [quoteMin, setQuoteMin] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A quote belongs to the session it was taken in: drop it when the wallet
  // switches account or network, and block a swap until re-quoted (#750).
  const { blockReason } = useSessionBoundForm([from, to, amount, quote]);
  useOnWalletSessionChange(() => { setQuote(null); setQuoteToken(null); setQuoteMin(null); });

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Security: Strictly enforce origin check against allowlist (blocks evil.com)
      if (!isAllowedMessageOrigin(event.origin)) {
        console.warn(
          "Dropped postMessage from untrusted origin:",
          event.origin,
        );
        return;
      }

      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "SET_SWAP" && data.payload) {
        if (
          data.payload.from &&
          ["XLM", "USDC", "EURC"].includes(data.payload.from)
        ) {
          setFrom(data.payload.from);
        }
        if (
          data.payload.to &&
          ["XLM", "USDC", "EURC"].includes(data.payload.to)
        ) {
          setTo(data.payload.to);
        }
        if (typeof data.payload.amount === "string") {
          setAmount(data.payload.amount);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const getQuote = async () => {
    setQuoteToken(null);
    setQuoteMin(null);
    setLoading(true);
    try {
      if (from === to) throw new Error("Choose two different assets");
      const canonicalAmount = canonicalizeStellarAmount(amount);
      const res = await relayerFetch(
        `/swap/quote?from=${from}&to=${to}&amount=${canonicalAmount}`,
      );
      const text = await res.text();
      let j: any = {};
      try {
        j = text ? JSON.parse(text) : {};
      } catch {
        j = {};
      }
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const exactDestination = canonicalizeStellarAmount(String(j.destAmount));
      const destinationStroops = parseStroops(exactDestination);
      if (
        j.destStroops !== undefined &&
        BigInt(String(j.destStroops)) !== destinationStroops
      ) {
        throw new Error("Quote amount did not match its stroop value");
      }
      if (
        j.destSorobanAmount !== undefined &&
        BigInt(String(j.destSorobanAmount)) !==
          horizonStroopsToSorobanAmount(destinationStroops)
      ) {
        throw new Error("Quote used an invalid 7-to-12 decimal conversion");
      }
      if (j.source === "soroswap") {
        const expectedContractId = import.meta.env.VITE_SOROSWAP_CONTRACT_ID as
          | string
          | undefined;
        if (!expectedContractId || j.contractId !== expectedContractId) {
          throw new Error("Soroswap quote contract is not pinned or does not match");
        }
      }
      if (!j.executable || !j.quoteToken) throw new Error("No executable Horizon quote available");
      setQuoteToken(j.quoteToken);
      setQuoteMin((destinationStroops * 99n / 100n).toString());
      setQuote(`${exactDestination} ${to}`);
    } catch (e: any) {
      setQuote(`Quote unavailable${e.message ? `: ${e.message}` : ""}`);
    } finally {
      setLoading(false);
    }
  };

  const doSwap = async () => {
    const sessionBlock = blockReason();
    if (sessionBlock) {
      setQuote(null);
      alert(`${sessionBlock} Get a new quote first.`);
      return;
    }
    if (!quoteToken || !quoteMin) { alert("Get a fresh executable quote first."); return; }
    setLoading(true);
    try {
      if (from === to) throw new Error("Choose two different assets");
      const canonicalAmount = canonicalizeStellarAmount(amount);
      const res = await relayerFetch(`/swap/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, amount: canonicalAmount, quoteToken, destMin: formatStroops(BigInt(quoteMin)) }),
      });
      const text = await res.text();
      let j: any = {};
      try {
        j = text ? JSON.parse(text) : {};
      } catch {
        j = { raw: text };
      }
      if (!res.ok)
        throw new Error(j.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
      setQuoteToken(null);
      setQuoteMin(null);
      setQuote(null);
      alert(j.hash ? `Swap submitted: ${j.hash}` : JSON.stringify(j));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border p-6 bg-card space-y-4">
      <h3 className="text-lg font-semibold">Swap XLM / USDC / EURC (real)</h3>
      <div className="grid grid-cols-3 gap-3">
        <select
          aria-label="Swap from"
          value={from}
          onChange={(e) => setFrom(e.target.value as Asset)}
          className="border rounded px-3 py-2 bg-background"
        >
          <option>XLM</option>
          <option>USDC</option>
          <option>EURC</option>
        </select>
        <span className="text-center py-2" aria-hidden="true">→</span>
        <select
          aria-label="Swap to"
          value={to}
          onChange={(e) => setTo(e.target.value as Asset)}
          className="border rounded px-3 py-2 bg-background"
        >
          <option>USDC</option>
          <option>XLM</option>
          <option>EURC</option>
        </select>
      </div>
      <input
        aria-label="Amount"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount"
        className="w-full border rounded px-3 py-2 bg-background"
      />
      <div className="flex gap-2">
        <Button
          onClick={getQuote}
          disabled={loading}
          variant="outline"
          className="flex-1"
        >
          {loading ? "..." : "Quote (Horizon/Soroswap)"}
        </Button>
        <Button onClick={doSwap} disabled={loading} className="flex-1">
          Swap
        </Button>
      </div>
      {quote && (
        <div className="text-sm text-muted-foreground">Quote: {quote}</div>
      )}
      <p className="text-xs text-muted-foreground">
        Real assets via Horizon strict-send + Soroswap fallback. No mocks.
      </p>
    </div>
  );
}
