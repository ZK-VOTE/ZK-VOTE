/**
 * Treasury signer dashboard (ZV-039 / #888).
 *
 * Lists the treasury's multisig signing sessions and lets the connected
 * signer sign a proposal's approval message with their wallet. Each
 * signature is bound to the proposal's on-chain digest and expiry, so the
 * dashboard shows both before asking the wallet to sign.
 *
 * The admin routes need an operator credential, which is never part of the
 * bundle (#647): the admin console passes its session headers in.
 */
import { useCallback, useEffect, useState } from "react";
import { RELAYER_URL } from "../config/env";

type SessionStatus = "collecting" | "ready" | "executed" | "expired";

interface SigningSession {
  id: string;
  proposalId: number;
  digest: string;
  action:
    | { kind: "spend"; token: string; to: string; amount: string }
    | { kind: "rotate"; signers: string[]; threshold: number; largeAmount: string; largeThreshold: number };
  signers: string[];
  required: number;
  expiresAt: number;
  status: SessionStatus;
  signatures: { signer: string; signedAt: number }[];
  stellarTxHash: string | null;
}

export interface TreasurySignerDashboardProps {
  /** The connected wallet's address. */
  signerAddress: string | null;
  /** The wallet's SEP-53 signMessage, returning a base64 signature. */
  signMessage: (message: string) => Promise<string>;
  /** Operator session headers for the admin routes. */
  authHeaders: Record<string, string>;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

const short = (value: string) => (value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);

function describe(action: SigningSession["action"]): string {
  return action.kind === "spend"
    ? `Pay ${action.amount} to ${short(action.to)}`
    : `Rotate signers to ${action.signers.length} (threshold ${action.threshold}, large ${action.largeThreshold})`;
}

export default function TreasurySignerDashboard({
  signerAddress,
  signMessage,
  authHeaders,
  fetchImpl = fetch,
  apiBase = `${RELAYER_URL}/api/v1`,
}: TreasurySignerDashboardProps) {
  const [sessions, setSessions] = useState<SigningSession[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchImpl(`${apiBase}/admin/treasury/sessions`, { headers: authHeaders });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSessions((await res.json()).sessions);
    } catch (err) {
      setSessions([]);
      setStatus(`Could not load signing sessions: ${(err as Error).message}`);
    }
  }, [apiBase, authHeaders, fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sign(session: SigningSession) {
    if (!signerAddress) return;
    setBusy(session.id);
    setStatus(null);
    try {
      // The exact message the relayer verifies: it names this proposal's digest and expiry.
      const detail = await fetchImpl(`${apiBase}/admin/treasury/sessions/${session.id}`, { headers: authHeaders });
      const { message } = await detail.json();
      const signature = await signMessage(message);
      const res = await fetchImpl(`${apiBase}/admin/treasury/sessions/${session.id}/signatures`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ signer: signerAddress, signature }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSessions((list) => list?.map((s) => (s.id === session.id ? body.session : s)) ?? null);
      setStatus(body.session.status === "ready" ? "Signed. The threshold is met; the proposal can be executed." : "Signed.");
    } catch (err) {
      setStatus(`Signing failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="treasury-signing-heading" className="space-y-3">
      <h3 id="treasury-signing-heading" className="font-semibold">Treasury approvals</h3>
      {sessions === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {sessions?.length === 0 && !status && <p className="text-sm text-muted-foreground">No proposals need signatures.</p>}
      <ul className="space-y-2">
        {sessions?.map((session) => {
          const isSigner = !!signerAddress && session.signers.includes(signerAddress);
          const signed = session.signatures.some((s) => s.signer === signerAddress);
          const canSign = isSigner && !signed && (session.status === "collecting" || session.status === "ready");
          return (
            <li key={session.id} className="rounded-md border p-3 text-sm space-y-1" data-testid="treasury-session">
              <p className="font-medium">
                #{session.proposalId}: {describe(session.action)}
              </p>
              <p>
                {session.signatures.length} of {session.required} signatures · {session.status}
              </p>
              <p className="font-mono text-xs truncate" title={session.digest}>
                digest {session.digest}
              </p>
              <p className="text-xs text-muted-foreground">
                expires {new Date(session.expiresAt * 1000).toLocaleString()}
              </p>
              {canSign && (
                <button
                  type="button"
                  className="rounded-md border px-3 py-1"
                  disabled={busy === session.id}
                  onClick={() => void sign(session)}
                >
                  Sign approval
                </button>
              )}
              {signed && <p className="text-xs">You signed this proposal.</p>}
            </li>
          );
        })}
      </ul>
      {status && (
        <p role="status" className="text-sm">
          {status}
        </p>
      )}
    </section>
  );
}
