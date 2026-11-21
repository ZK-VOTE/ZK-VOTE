import { useCallback, useEffect, useState } from "react";
import { TREASURY_ESCROW_ADDRESS } from "../config/env";
import {
  etherToWeiDecimal,
  fetchLocksForProposal,
  reportLock,
  reportRefund,
  sendLockTransaction,
  sendRefundTransaction,
  waitForLockId,
  type EscrowLockRecord,
} from "../lib/treasuryEscrow";

interface TreasuryEscrowPanelProps {
  daoId: number;
  proposalId: number;
  evmAddress: string | null;
}

type PanelState =
  | { phase: "idle" }
  | { phase: "locking" }
  | { phase: "refunding" }
  | { phase: "error"; message: string };

const STATUS_LABEL: Record<EscrowLockRecord["status"], string> = {
  locked: "Locked",
  released: "Released",
  cancelled: "Cancelled (early unlock)",
  refunded: "Refunded",
};

const STATUS_CLASS: Record<EscrowLockRecord["status"], string> = {
  locked: "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300",
  released: "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300",
  cancelled: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
  refunded: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
};

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function secondsUntilRefundable(lock: EscrowLockRecord): number {
  const refundableAt = lock.createdAt + lock.timeoutSeconds;
  return Math.max(0, refundableAt - Math.floor(Date.now() / 1000));
}

/**
 * TreasuryEscrowPanel - satellite treasury lock/refund status (ZV-107)
 *
 * `TreasuryEscrow.sol` is the source of truth for fund custody. This panel
 * lets a connected EVM wallet lock funds for the proposal and, once the
 * 24h timeout has elapsed without release/cancellation, reclaim them.
 * Release and early cancellation require a Soroban finality/cancellation
 * proof and are only performed by the relayer, so they aren't user actions
 * here (see backend/src/services/treasuryEscrow.ts).
 */
export function TreasuryEscrowPanel({
  daoId,
  proposalId,
  evmAddress,
}: TreasuryEscrowPanelProps) {
  const [locks, setLocks] = useState<EscrowLockRecord[]>([]);
  const [recipient, setRecipient] = useState("");
  const [amountEth, setAmountEth] = useState("");
  const [state, setState] = useState<PanelState>({ phase: "idle" });

  const refreshLocks = useCallback(async () => {
    if (!TREASURY_ESCROW_ADDRESS) return;
    try {
      const result = await fetchLocksForProposal(daoId, proposalId);
      setLocks(result);
    } catch {
      // Status cache is best-effort; leave the last known list in place.
    }
  }, [daoId, proposalId]);

  useEffect(() => {
    refreshLocks();
  }, [refreshLocks]);

  const handleLock = useCallback(async () => {
    if (!evmAddress || !window.ethereum) return;
    if (!recipient || !amountEth) return;

    setState({ phase: "locking" });
    try {
      const txHash = await sendLockTransaction(window.ethereum, {
        from: evmAddress,
        escrowAddress: TREASURY_ESCROW_ADDRESS,
        daoId,
        proposalId,
        recipient,
        amountEth,
      });

      const lockId = await waitForLockId(
        window.ethereum,
        txHash,
        TREASURY_ESCROW_ADDRESS,
      );

      await reportLock({
        lockId,
        daoId,
        proposalId,
        depositor: evmAddress,
        recipient,
        amount: etherToWeiDecimal(amountEth),
        lockTxHash: txHash,
      });

      setState({ phase: "idle" });
      setAmountEth("");
      setRecipient("");
      await refreshLocks();
    } catch (err) {
      setState({ phase: "error", message: (err as Error).message });
    }
  }, [evmAddress, recipient, amountEth, daoId, proposalId, refreshLocks]);

  const handleRefund = useCallback(
    async (lock: EscrowLockRecord) => {
      if (!evmAddress || !window.ethereum) return;

      setState({ phase: "refunding" });
      try {
        const txHash = await sendRefundTransaction(window.ethereum, {
          from: evmAddress,
          escrowAddress: TREASURY_ESCROW_ADDRESS,
          lockId: lock.lockId,
        });
        await reportRefund(lock.lockId, txHash);
        setState({ phase: "idle" });
        await refreshLocks();
      } catch (err) {
        setState({ phase: "error", message: (err as Error).message });
      }
    },
    [evmAddress, refreshLocks],
  );

  if (!TREASURY_ESCROW_ADDRESS) {
    return null;
  }

  return (
    <div className="p-4 border rounded-lg space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Satellite Treasury Escrow</h3>
        <span className="text-xs px-2 py-1 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded">
          EVM
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        Funds locked here release to the recipient only after this
        proposal&apos;s Soroban vote reaches finality. If it isn&apos;t
        finalized or cancelled within 24 hours, you can reclaim your funds.
      </p>

      {evmAddress && (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="escrow-recipient">
            Recipient address
          </label>
          <input
            id="escrow-recipient"
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x..."
            className="w-full px-3 py-2 border rounded-lg bg-background text-sm font-mono"
          />
          <label className="text-sm font-medium" htmlFor="escrow-amount">
            Amount (ETH)
          </label>
          <input
            id="escrow-amount"
            type="text"
            value={amountEth}
            onChange={(e) => setAmountEth(e.target.value)}
            placeholder="0.5"
            className="w-full px-3 py-2 border rounded-lg bg-background text-sm"
          />
          <button
            onClick={handleLock}
            disabled={
              state.phase === "locking" || !recipient || !amountEth
            }
            className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white rounded-lg transition-colors"
          >
            {state.phase === "locking" ? "Locking..." : "Lock Funds in Escrow"}
          </button>
        </div>
      )}

      {locks.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Locks for this proposal</h4>
          {locks.map((lock) => {
            const remaining = secondsUntilRefundable(lock);
            const refundable = lock.status === "locked" && remaining === 0;
            return (
              <div
                key={lock.lockId}
                className="p-3 border rounded-lg space-y-1 text-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">
                    Lock #{lock.lockId}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${STATUS_CLASS[lock.status]}`}
                  >
                    {STATUS_LABEL[lock.status]}
                  </span>
                </div>
                {lock.status === "locked" && !refundable && (
                  <p className="text-xs text-muted-foreground">
                    Refundable in {formatRemaining(remaining)} if not
                    finalized or cancelled before then.
                  </p>
                )}
                {refundable && evmAddress === lock.depositor && (
                  <button
                    onClick={() => handleRefund(lock)}
                    disabled={state.phase === "refunding"}
                    className="w-full mt-1 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white rounded-lg text-xs transition-colors"
                  >
                    {state.phase === "refunding"
                      ? "Claiming..."
                      : "Claim Refund"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {state.phase === "error" && (
        <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-700 dark:text-red-300">
            {state.message}
          </p>
        </div>
      )}
    </div>
  );
}

export default TreasuryEscrowPanel;
