import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/Button";
import { relayerFetch } from "../lib/api";
import {
  isTrustedAnchorMessage,
  parseTrustedAnchorSession,
} from "../lib/anchorMessaging";
import { isAllowedMessageOrigin } from "../lib/messageOrigin";
import { canonicalizeStellarAmount } from "../lib/stellarAmount";
import {
  useOnWalletSessionChange,
  useSessionBoundForm,
} from "../hooks/useWalletSession";

type Asset = "USDC" | "EURC";

export default function DepositWithdraw() {
  const [asset, setAsset] = useState<Asset>("USDC");
  const [amount, setAmount] = useState("100");
  const [account, setAccount] = useState("");
  const [info, setInfo] = useState<any>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const anchorSession = useMemo(() => parseTrustedAnchorSession(info), [info]);
  // An open anchor flow was started for the previous session's context:
  // close it on a wallet switch rather than let it complete under the new
  // one, and make the user re-confirm the form (#750).
  const { blockReason } = useSessionBoundForm([asset, amount, account]);
  useOnWalletSessionChange(() =>
    setInfo((current: Record<string, unknown> | null) =>
      current?.interactiveUrl
        ? { error: "Your wallet changed, so the deposit window was closed. Start again to continue." }
        : current,
    ),
  );

  useEffect(() => {
    if (!anchorSession) return;
    const session = anchorSession;
    const onMessage = async (event: MessageEvent) => {
      if (
        !isTrustedAnchorMessage(
          event,
          iframeRef.current?.contentWindow ?? null,
          session,
        )
      )
        return;

      // Server-side one-time nonce consumption closes the replay window even
      // if a browser handler is re-entered or the same message is resent.
      try {
        const verification = await relayerFetch("/ramp/session/nonce/consume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: session.sessionId,
            token: session.token,
            popupNonce: session.nonce,
            popupOrigin: event.origin,
          }),
        });
        if (!verification.ok) return;
      } catch {
        console.warn("SEP-24 popup message was not accepted by the session verifier");
        return;
      }

      const type = (event.data as { type: string }).type;
      if (type === "sep24:close" || type === "sep24:complete") {
        setInfo((current: Record<string, unknown> | null) => ({
          ...current,
          interactiveUrl: undefined,
          interactiveOrigin: undefined,
          status: type,
        }));
      } else if (type === "sep24:error") {
        setInfo((current: Record<string, unknown> | null) => ({
          ...current,
          error: "The anchor reported an interactive deposit error",
        }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [anchorSession]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Security: Strictly enforce same-origin for ramps/deposits (blocks evil.com and external embedders)
      if (!isAllowedMessageOrigin(event.origin, "ramp")) {
        console.warn(
          "Dropped ramp postMessage from untrusted or non-same origin:",
          event.origin,
        );
        return;
      }

      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "SET_RAMP" && data.payload) {
        if (
          data.payload.asset &&
          ["USDC", "EURC"].includes(data.payload.asset)
        ) {
          setAsset(data.payload.asset);
        }
        if (typeof data.payload.amount === "string") {
          setAmount(data.payload.amount);
        }
        if (typeof data.payload.account === "string") {
          setAccount(data.payload.account);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const deposit = async () => {
    try {
      const sessionBlock = blockReason();
      if (sessionBlock) throw new Error(sessionBlock);
      const canonicalAmount = canonicalizeStellarAmount(amount);
      if (!/^G[A-Z2-7]{55}$/.test(account))
        throw new Error("Enter a valid Stellar G address");
      const res = await relayerFetch(
        `/ramp/deposit?asset=${asset}&account=${account}&amount=${canonicalAmount}`,
      );
      const text = await res.text();
      let j: any = {};
      try {
        j = text ? JSON.parse(text) : {};
      } catch {
        j = { raw: text };
      }
      if (!res.ok)
        throw new Error(j.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
      setInfo(j);
    } catch (e: any) {
      setInfo({ error: e.message });
    }
  };
  const withdraw = async () => {
    try {
      const sessionBlock = blockReason();
      if (sessionBlock) throw new Error(sessionBlock);
      const canonicalAmount = canonicalizeStellarAmount(amount);
      if (!/^G[A-Z2-7]{55}$/.test(account))
        throw new Error("Enter a valid Stellar G address");
      const res = await relayerFetch(
        `/ramp/withdraw?asset=${asset}&account=${account}&amount=${canonicalAmount}&dest=bank`,
      );
      const text = await res.text();
      let j: any = {};
      try {
        j = text ? JSON.parse(text) : {};
      } catch {
        j = { raw: text };
      }
      if (!res.ok)
        throw new Error(j.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
      setInfo(j);
    } catch (e: any) {
      setInfo({ error: e.message });
    }
  };

  return (
    <div className="rounded-xl border p-6 bg-card space-y-4">
      <h3 className="text-lg font-semibold">
        Inflow / Outflow — SEP-6/24/31 (real anchors)
      </h3>
      <div className="flex gap-3">
        <select
          value={asset}
          onChange={(e) => setAsset(e.target.value as Asset)}
          className="border rounded px-3 py-2 bg-background flex-1"
        >
          <option>USDC</option>
          <option>EURC</option>
        </select>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="border rounded px-3 py-2 bg-background flex-1"
          placeholder="Amount"
        />
      </div>
      <input
        value={account}
        onChange={(e) => setAccount(e.target.value)}
        placeholder="Stellar account G..."
        className="w-full border rounded px-3 py-2 bg-background font-mono text-sm"
      />
      <div className="flex gap-2">
        <Button onClick={deposit} variant="outline" className="flex-1">
          Deposit (SEP-6)
        </Button>
        <Button onClick={withdraw} variant="outline" className="flex-1">
          Withdraw (SEP-6 → bank)
        </Button>
      </div>
      {info && (
        <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-40">
          {JSON.stringify(info, null, 2)}
        </pre>
      )}
      {anchorSession && (
        <iframe
          ref={iframeRef}
          src={anchorSession.url}
          title={`${asset} anchor deposit`}
          sandbox="allow-forms allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className="h-[32rem] w-full rounded border"
        />
      )}
      <p className="text-xs text-muted-foreground">
        Circle USDC/EURC anchors via ANCHOR_USDC_URL / ANCHOR_EURC_URL.
        High-volume via claimableBalance.
      </p>
    </div>
  );
}
