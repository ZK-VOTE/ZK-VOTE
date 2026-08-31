import { useState, useCallback } from "react";

interface BridgePanelProps {
  daoId: number;
  proposalId: number;
  isConnected: boolean;
  onVoteSubmitted?: (txHash: string) => void;
}

interface BridgeVoteState {
  status: "idle" | "generating" | "submitting" | "success" | "error";
  txHash?: string;
  error?: string;
  gasEstimate?: string;
}

const PROOF_GENERATION_DELAY_MS = import.meta.env.MODE === "test" ? 0 : 2000;

/**
 * BridgePanel - Cross-chain voting UI
 *
 * Allows DAO members to vote from Ethereum using their Stellar SBT membership.
 * When the user connects an EVM wallet, this panel shows the "Vote from Ethereum" option.
 *
 * Flow:
 * 1. User connects EVM wallet (MetaMask, etc.)
 * 2. User selects vote choice (for/against)
 * 3. System generates Groth16 proof (bridge.circom)
 * 4. Proof is submitted to EVM bridge contract
 * 5. Relayer picks up VoteForwarded event and relays to Soroban
 */
export function BridgePanel({
  daoId,
  proposalId,
  isConnected,
  onVoteSubmitted,
}: BridgePanelProps) {
  const [voteChoice, setVoteChoice] = useState<boolean | null>(null);
  const [voteState, setVoteState] = useState<BridgeVoteState>({
    status: "idle",
  });
  const [evmConnected, setEvmConnected] = useState(false);
  const [evmAddress, setEvmAddress] = useState<string | null>(null);

  const connectEVMWallet = useCallback(async () => {
    try {
      if (typeof window.ethereum === "undefined") {
        setVoteState({
          status: "error",
          error: "No EVM wallet detected. Please install MetaMask.",
        });
        return;
      }

      const result = await window.ethereum.request({
        method: "eth_requestAccounts",
      });
      const accounts = Array.isArray(result)
        ? result.filter((a): a is string => typeof a === "string")
        : [];

      if (accounts.length > 0) {
        setEvmAddress(accounts[0]);
        setEvmConnected(true);
      }
    } catch (err) {
      setVoteState({
        status: "error",
        error: "Failed to connect EVM wallet: " + (err as Error).message,
      });
    }
  }, []);

  const submitBridgeVote = useCallback(async () => {
    if (voteChoice === null) return;

    setVoteState({ status: "generating" });

    try {
      // In production, this would:
      // 1. Fetch SBT state witness from relayer
      // 2. Generate Groth16 proof using snarkjs WASM
      // 3. Submit proof to EVM bridge contract
      // 4. Wait for VoteForwarded event

      // Simulate proof generation
      await new Promise((resolve) =>
        setTimeout(resolve, PROOF_GENERATION_DELAY_MS),
      );

      setVoteState({ status: "submitting" });

      // Submit to backend bridge endpoint
      const response = await fetch("/bridge/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daoId,
          proposalId,
          voteChoice: voteChoice ? 1 : 0,
          nullifier: "0x" + "0".repeat(64), // Placeholder
          voteRoot: "0x" + "0".repeat(64), // Placeholder
          sbtRoot: "0x" + "0".repeat(64), // Placeholder
          proof: {
            a: "0x" + "0".repeat(128),
            b: "0x" + "0".repeat(256),
            c: "0x" + "0".repeat(128),
          },
        }),
      });

      const result = await response.json();

      if (result.success) {
        setVoteState({
          status: "success",
          txHash: result.txHash,
        });
        onVoteSubmitted?.(result.txHash);
      } else {
        setVoteState({
          status: "error",
          error: result.error || "Vote submission failed",
        });
      }
    } catch (err) {
      setVoteState({
        status: "error",
        error: "Bridge vote failed: " + (err as Error).message,
      });
    }
  }, [daoId, proposalId, voteChoice, onVoteSubmitted]);

  if (!isConnected) {
    return (
      <div className="p-4 border rounded-lg bg-muted/50">
        <p className="text-sm text-muted-foreground">
          Connect your Stellar wallet to enable cross-chain voting.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 border rounded-lg space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Vote from Ethereum</h3>
        <span className="text-xs px-2 py-1 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded">
          Cross-chain
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        Use your Stellar SBT membership to vote from Ethereum. Your identity
        remains anonymous via zero-knowledge proofs.
      </p>

      {/* EVM Wallet Connection */}
      {!evmConnected ? (
        <button
          onClick={connectEVMWallet}
          className="w-full px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors"
        >
          Connect MetaMask
        </button>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <span className="w-2 h-2 bg-green-500 rounded-full" />
          <span className="font-mono text-xs">
            {evmAddress?.slice(0, 6)}...{evmAddress?.slice(-4)}
          </span>
        </div>
      )}

      {/* Vote Choice */}
      {evmConnected && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Vote Choice</label>
          <div className="flex gap-2">
            <button
              onClick={() => setVoteChoice(true)}
              className={`flex-1 px-4 py-2 rounded-lg border transition-colors ${
                voteChoice === true
                  ? "bg-green-500 text-white border-green-500"
                  : "bg-background hover:bg-green-50 dark:hover:bg-green-950 border-border"
              }`}
            >
              For
            </button>
            <button
              onClick={() => setVoteChoice(false)}
              className={`flex-1 px-4 py-2 rounded-lg border transition-colors ${
                voteChoice === false
                  ? "bg-red-500 text-white border-red-500"
                  : "bg-background hover:bg-red-50 dark:hover:bg-red-950 border-border"
              }`}
            >
              Against
            </button>
          </div>
        </div>
      )}

      {/* Submit Button */}
      {evmConnected && voteChoice !== null && (
        <button
          onClick={submitBridgeVote}
          disabled={voteState.status !== "idle"}
          className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white rounded-lg transition-colors"
        >
          {voteState.status === "idle" && "Submit Cross-Chain Vote"}
          {voteState.status === "generating" && "Generating Proof..."}
          {voteState.status === "submitting" && "Submitting..."}
          {voteState.status === "success" && "Vote Submitted!"}
          {voteState.status === "error" && "Retry"}
        </button>
      )}

      {/* Status Messages */}
      {voteState.status === "success" && voteState.txHash && (
        <div className="p-3 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg">
          <p className="text-sm text-green-700 dark:text-green-300">
            Vote submitted successfully!
          </p>
          <p className="text-xs font-mono text-green-600 dark:text-green-400 mt-1">
            TX: {voteState.txHash.slice(0, 10)}...{voteState.txHash.slice(-8)}
          </p>
        </div>
      )}

      {voteState.status === "error" && voteState.error && (
        <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-700 dark:text-red-300">
            {voteState.error}
          </p>
        </div>
      )}

      {/* Info Footer */}
      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          Powered by Groth16 ZK proofs on BN254. Your SBT membership is verified
          without revealing your identity.
        </p>
        <p>Gas cost target: &lt;500k gas for proof verification on EVM.</p>
      </div>
    </div>
  );
}

export default BridgePanel;
