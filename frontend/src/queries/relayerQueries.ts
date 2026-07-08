import { useQuery } from "@tanstack/react-query";
import { CONTRACTS, NETWORK_CONFIG } from "../config/contracts";
import { checkRelayerReady, fetchRelayerConfig } from "../lib/stellar";
import type { RelayerConfig } from "../lib/stellar";
import { queryKeys } from "../lib/queryClient";

export type RelayerStatus =
  | { state: "missing-url"; message: string }
  | { state: "error"; message: string }
  | { state: "ready"; message: string }
  | { state: "mismatch"; message: string; mismatches: string[] };

// Use environment variable with fallback to localhost for development
const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:3001";

interface RelayerStatusData {
  status: RelayerStatus;
  relayerConfig: RelayerConfig | null;
}

/**
 * Check config mismatches between relayer and local config
 */
function checkConfigMismatches(config: RelayerConfig): string[] {
  const mismatches: string[] = [];

  if (config.votingContract && config.votingContract !== CONTRACTS.VOTING_ID) {
    mismatches.push(
      `Relayer votingContract (${config.votingContract}) differs from local config (${CONTRACTS.VOTING_ID})`,
    );
  }
  if (config.treeContract && config.treeContract !== CONTRACTS.TREE_ID) {
    mismatches.push(
      `Relayer treeContract (${config.treeContract}) differs from local config (${CONTRACTS.TREE_ID})`,
    );
  }
  if (
    config.networkPassphrase &&
    config.networkPassphrase !== NETWORK_CONFIG.networkPassphrase
  ) {
    mismatches.push(
      `Relayer networkPassphrase differs from local config (${NETWORK_CONFIG.networkPassphrase})`,
    );
  }
  if (config.rpc && config.rpc !== NETWORK_CONFIG.rpcUrl) {
    mismatches.push(
      `Relayer RPC differs from local config (${NETWORK_CONFIG.rpcUrl})`,
    );
  }

  return mismatches;
}

/**
 * Fetch relayer status and config
 */
async function fetchRelayerStatus(): Promise<RelayerStatusData> {
  const relayerUrl = RELAYER_URL;

  if (!relayerUrl) {
    return {
      status: { state: "missing-url", message: "Relayer URL not configured" },
      relayerConfig: null,
    };
  }

  // Check if relayer is ready
  const healthCheck = await checkRelayerReady(relayerUrl);

  if (!healthCheck.ok) {
    return {
      status: {
        state: "error",
        message: healthCheck.error || "relayer not ready",
      },
      relayerConfig: null,
    };
  }

  // Try to fetch config
  let config: RelayerConfig | null = null;
  try {
    config = await fetchRelayerConfig(relayerUrl);
  } catch {
    // Config fetch failed, but health check passed
    return {
      status: { state: "ready", message: "relayer ready" },
      relayerConfig: null,
    };
  }

  // Check for mismatches
  const mismatches = checkConfigMismatches(config);

  if (mismatches.length > 0) {
    return {
      status: {
        state: "mismatch",
        message: "relayer config mismatch",
        mismatches,
      },
      relayerConfig: config,
    };
  }

  return {
    status: { state: "ready", message: "relayer ready" },
    relayerConfig: config,
  };
}

/**
 * React Query hook for relayer status.
 * Replaces useRelayerStatus with caching and automatic refetching.
 */
export function useRelayerStatusQuery() {
  const query = useQuery({
    queryKey: queryKeys.relayer.status(),
    queryFn: fetchRelayerStatus,
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: 60 * 1000, // Refetch every minute
    retry: 2,
  });

  return {
    status: query.data?.status ?? null,
    relayerConfig: query.data?.relayerConfig ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
