import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/Button";
import { relayerFetch, generateIdempotencyKey } from "../lib/api";
import { isAllowedMessageOrigin } from "../lib/messageOrigin";
import { canonicalizeStellarAmount } from "../lib/stellarAmount";
import { useSessionBoundForm } from "../hooks/useWalletSession";

type Asset = "XLM" | "USDC" | "EURC";

interface PendingPayment {
  idempotencyKey: string;
  hash?: string;
  timestamp: number;
}

export default function PayPanel() {
  const [asset, setAsset] = useState<Asset>("XLM");
  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState("5");
  const [memo, setMemo] = useState("");
  const [loading, setLoading] = useState(false);
  const [trustlineMessage, setTrustlineMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const pendingPaymentRef = useRef<PendingPayment | null>(null);
  // A payment filled in under one wallet session must be reviewed again
  // after an account or network switch before it is sent (#750).
  const { blockReason } = useSessionBoundForm([asset, dest, amount, memo]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Security: Strictly enforce same-origin for payments (blocks evil.com and external embedders)
      if (!isAllowedMessageOrigin(event.origin, "payment")) {
        console.warn("Dropped payment postMessage from untrusted or non-same origin:", event.origin);
        return;
      }

      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "SET_PAYMENT" && data.payload) {
        if (data.payload.asset && ["XLM", "USDC", "EURC"].includes(data.payload.asset)) {
          setAsset(data.payload.asset);
        }
        if (typeof data.payload.destination === "string") {
          setDest(data.payload.destination);
        }
        if (typeof data.payload.amount === "string") {
          setAmount(data.payload.amount);
        }
        if (typeof data.payload.memo === "string") {
          setMemo(data.payload.memo);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const checkDestinationTrustline = async (): Promise<boolean> => {
    if (asset === "XLM") {
      setTrustlineMessage("XLM does not require a trustline.");
      return true;
    }
    if (!dest) {
      setTrustlineMessage("Enter a destination before checking its trustline.");
      return false;
    }

    try {
      const res = await relayerFetch(
        `/pay/trustline?account=${encodeURIComponent(dest)}&asset=${asset}`,
      );
      const text = await res.text();
      const status = text ? JSON.parse(text) : {};
      if (!res.ok) {
        setTrustlineMessage(status.error || "Unable to verify trustline.");
        return false;
      }
      if (status.ready) {
        setTrustlineMessage(`${asset} trustline is ready.`);
        return true;
      }
      const detail =
        status.reason === "issuer_authorization_required"
          ? `The ${asset} trustline exists but issuer authorization is still required.`
          : `Destination must create a ${asset} trustline to ${status.issuer}.`;
      setTrustlineMessage(detail);
      return false;
    } catch (error: any) {
      setTrustlineMessage(error.message || "Unable to verify trustline.");
      return false;
    }
  };

  const send = async () => {
    if (!dest) return alert("Destination required (G... or M...)");
    const sessionBlock = blockReason();
    if (sessionBlock) return alert(sessionBlock);
    const canonicalAmount = canonicalizeStellarAmount(amount);
    if (!(await checkDestinationTrustline())) return;
    
    // Check if there's already a pending payment
    if (pendingPaymentRef.current) {
      const age = Date.now() - pendingPaymentRef.current.timestamp;
      if (age < 10000) { // 10 seconds
        alert(`Payment already in progress (${pendingPaymentRef.current.idempotencyKey}). Please wait...`);
        return;
      }
    }
    setLoading(true);
    const idempotencyKey = generateIdempotencyKey("pay");
    const pendingPayment: PendingPayment = { idempotencyKey, timestamp: Date.now() };
    
    setPending(pendingPayment);
    pendingPaymentRef.current = pendingPayment;
    
    try {
      const res = await relayerFetch("/pay", { 
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ asset, destination: dest, amount: canonicalAmount, memo }),
        idempotencyKey,
      });
      const text = await res.text();
      let j: any = {};
      try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
      
      // Update pending with hash
      const updatedPending = { ...pendingPayment, hash: j.hash };
      setPending(updatedPending);
      pendingPaymentRef.current = updatedPending;
      
      alert(j.hash ? `Payment sent: ${j.hash}` : JSON.stringify(j));
    } catch (e: any) { 
      alert(e.message); 
    } finally { 
      setLoading(false);
      // Clear pending after a delay
      setTimeout(() => {
        setPending(null);
        pendingPaymentRef.current = null;
      }, 5000);
    }
  };

  const sendBatch = async () => {
    if (!dest) return alert("Destination required (G... or M...)");
    const sessionBlock = blockReason();
    if (sessionBlock) return alert(sessionBlock);
    const canonicalAmount = canonicalizeStellarAmount(amount);
    if (!(await checkDestinationTrustline())) return;
    const ops = Array.from({ length: 3 }, () => ({
      destination: dest,
      asset,
      amount: canonicalAmount,
    }));
    
    // Check if there's already a pending batch
    if (pendingPaymentRef.current) {
      const age = Date.now() - pendingPaymentRef.current.timestamp;
      if (age < 10000) {
        alert(`Batch payment already in progress. Please wait...`);
        return;
      }
    }
    
    setLoading(true);
    const idempotencyKey = generateIdempotencyKey("batch");
    const pendingPayment: PendingPayment = { idempotencyKey, timestamp: Date.now() };
    
    setPending(pendingPayment);
    pendingPaymentRef.current = pendingPayment;
    
    try {
      const j = await sendBatchPayment(ops);
      alert(j.hash ? `Batch ${j.ops} sent: ${j.hash}` : JSON.stringify(j));
    } catch (e: any) { 
      alert(e.message); 
    } finally { 
      setLoading(false);
      // Clear pending after a delay
      setTimeout(() => {
        setPending(null);
        pendingPaymentRef.current = null;
      }, 5000);
    }
  };

  return (
    <div className="rounded-xl border p-6 bg-card space-y-4">
      <h3 className="text-lg font-semibold">Pay XLM / USDC / EURC (real, high-volume)</h3>
      {pending && (
        <div className="bg-yellow-100 border border-yellow-300 rounded p-2 text-sm">
          <strong>Payment {pending.hash ? "confirmed" : "pending"}:</strong> {pending.idempotencyKey}
          {pending.hash && <div className="text-xs mt-1">Hash: {pending.hash.slice(0, 16)}...</div>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <select aria-label="Asset" value={asset} onChange={e => { setAsset(e.target.value as Asset); setTrustlineMessage(null); }} className="border rounded px-3 py-2 bg-background">
          <option>XLM</option><option>USDC</option><option>EURC</option>
        </select>
        <input aria-label="Amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="Amount (7 decimals)" className="border rounded px-3 py-2 bg-background" />
      </div>
      <input aria-label="Destination address" value={dest} onChange={e => { setDest(e.target.value); setTrustlineMessage(null); }} placeholder="Destination G... or M... (muxed for inflow)" className="w-full border rounded px-3 py-2 bg-background font-mono text-sm" />
      <input aria-label="Memo (optional)" value={memo} onChange={e => setMemo(e.target.value)} placeholder="Memo (optional)" className="w-full border rounded px-3 py-2 bg-background" />
      {asset !== "XLM" && (
        <div className="rounded border p-3 text-sm space-y-2">
          <Button
            onClick={checkDestinationTrustline}
            disabled={loading || !dest}
            variant="outline"
          >
            Check {asset} trustline
          </Button>
          {trustlineMessage && (
            <div role="status" className="text-xs text-muted-foreground">{trustlineMessage}</div>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button onClick={send} disabled={loading || !!pending} className="flex-1">{loading ? "..." : "Send (withSequenceLock)"}</Button>
        <Button onClick={sendBatch} disabled={loading || !!pending} variant="outline" className="flex-1">Batch 3× (100/tx)</Button>
      </div>
      <p className="text-xs text-muted-foreground">Muxed M... for inflow, 100 ops/tx, fee-bump, idempotency via payment_jobs.</p>
    </div>
  );
}
