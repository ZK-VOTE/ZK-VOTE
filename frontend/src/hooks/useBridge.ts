import { useState, useCallback, useEffect } from "react";

interface BridgeState {
  evmConnected: boolean;
  evmAddress: string | null;
  chainId: number | null;
  isCorrectChain: boolean;
}

interface BridgeVoteParams {
  daoId: number;
  proposalId: number;
  voteChoice: boolean;
  nullifier: string;
  voteRoot: string;
  sbtRoot: string;
  proof: {
    a: string;
    b: string;
    c: string;
  };
}

interface BridgeVoteResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

const EXPECTED_CHAIN_ID = 31337; // Anvil/Hardhat local

/** The roots Bridge.sol has anchored for a proposal, as the relayer reads them on-chain. */
export interface BridgeRoots {
  sbtRoot: string;
  voteRoot: string;
  sbtRootBlock: number;
  /** False until the root updater has posted both roots; castVote rejects proofs until then. */
  anchored: boolean;
}

/**
 * Reads the anchored roots from GET /bridge/roots (#887). Returns null when
 * they cannot be read (bridge not configured, RPC down, bad response).
 */
export async function fetchBridgeRoots(
  daoId: number,
  proposalId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeRoots | null> {
  try {
    const response = await fetchImpl(`/bridge/roots/${daoId}/${proposalId}`);
    if (!response.ok) return null;
    const body = await response.json();
    if (typeof body?.sbtRoot !== "string" || typeof body?.voteRoot !== "string") return null;
    return {
      sbtRoot: body.sbtRoot,
      voteRoot: body.voteRoot,
      sbtRootBlock: Number(body.sbtRootBlock ?? 0),
      anchored: body.anchored === true,
    };
  } catch {
    return null;
  }
}

/**
 * useBridge - Hook for EVM wallet connection and cross-chain voting
 */
export function useBridge() {
  const [state, setState] = useState<BridgeState>({
    evmConnected: false,
    evmAddress: null,
    chainId: null,
    isCorrectChain: false,
  });

  // Check if MetaMask is available
  const isMetaMaskAvailable = typeof window !== "undefined" && window.ethereum;

  // Connect to MetaMask
  const connect = useCallback(async () => {
    if (!window.ethereum) {
      throw new Error("No EVM wallet detected. Please install MetaMask.");
    }

    try {
      const result = await window.ethereum.request({
        method: "eth_requestAccounts",
      });
      const accounts = Array.isArray(result)
        ? result.filter((a): a is string => typeof a === "string")
        : [];

      const chainIdHex = await window.ethereum.request({
        method: "eth_chainId",
      });
      const chainId = parseInt(chainIdHex as string, 16);

      if (accounts.length > 0) {
        setState({
          evmConnected: true,
          evmAddress: accounts[0],
          chainId,
          isCorrectChain: chainId === EXPECTED_CHAIN_ID,
        });
      }
    } catch (err) {
      throw new Error("Failed to connect: " + (err as Error).message);
    }
  }, []);

  // Disconnect
  const disconnect = useCallback(() => {
    setState({
      evmConnected: false,
      evmAddress: null,
      chainId: null,
      isCorrectChain: false,
    });
  }, []);

  // Switch to correct chain
  const switchChain = useCallback(async () => {
    if (!window.ethereum) return;

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + EXPECTED_CHAIN_ID.toString(16) }],
      });

      const chainIdHex = await window.ethereum.request({
        method: "eth_chainId",
      });
      const chainId = parseInt(chainIdHex as string, 16);

      setState((prev) => ({
        ...prev,
        chainId,
        isCorrectChain: chainId === EXPECTED_CHAIN_ID,
      }));
    } catch (err) {
      throw new Error("Failed to switch chain: " + (err as Error).message);
    }
  }, []);

  // Submit bridge vote
  const submitVote = useCallback(
    async (params: BridgeVoteParams): Promise<BridgeVoteResult> => {
      if (!state.evmConnected || !state.evmAddress) {
        return { success: false, error: "EVM wallet not connected" };
      }

      try {
        const response = await fetch("/bridge/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...params,
            voterAddress: state.evmAddress,
          }),
        });

        const result = await response.json();
        return result;
      } catch (err) {
        return {
          success: false,
          error: "Bridge vote failed: " + (err as Error).message,
        };
      }
    },
    [state.evmConnected, state.evmAddress],
  );

  // Check nullifier status
  const checkNullifier = useCallback(
    async (
      daoId: number,
      proposalId: number,
      nullifier: string,
    ): Promise<boolean> => {
      try {
        const response = await fetch(
          `/bridge/nullifier/${daoId}/${proposalId}/${nullifier}`,
        );
        const result = await response.json();
        return result.used;
      } catch {
        return false;
      }
    },
    [],
  );

  // Listen for account/chain changes
  useEffect(() => {
    if (!window.ethereum) return;

    const handleAccountsChanged = (...args: unknown[]) => {
      const first = args[0];
      const accounts = Array.isArray(first)
        ? first.filter((a): a is string => typeof a === "string")
        : [];

      if (accounts.length === 0) {
        disconnect();
      } else if (state.evmConnected) {
        setState((prev) => ({
          ...prev,
          evmAddress: accounts[0],
        }));
      }
    };

    const handleChainChanged = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string") {
        const chainId = parseInt(first, 16);
        setState((prev) => ({
          ...prev,
          chainId,
          isCorrectChain: chainId === EXPECTED_CHAIN_ID,
        }));
      }
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum?.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener("chainChanged", handleChainChanged);
    };
  }, [state.evmConnected, disconnect]);

  const fetchRoots = useCallback(
    (daoId: number, proposalId: number) => fetchBridgeRoots(daoId, proposalId),
    [],
  );

  return {
    ...state,
    isMetaMaskAvailable: !!isMetaMaskAvailable,
    connect,
    disconnect,
    switchChain,
    submitVote,
    checkNullifier,
    fetchRoots,
  };
}

// Extend Window interface for MetaMask
declare global {
  interface Window {
    ethereum?: {
      request: (args: {
        method: string;
        params?: unknown[];
      }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (
        event: string,
        handler: (...args: unknown[]) => void,
      ) => void;
    };
  }
}
