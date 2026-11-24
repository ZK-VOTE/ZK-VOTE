import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { CONTRACTS, NETWORK_CONFIG } from "../config/contracts";
import { checkRelayerReady, fetchRelayerConfig } from "../lib/stellar";
import type { RelayerConfig } from "../lib/stellar";
import { queryKeys } from "../lib/queryClient";
import { nextRelayerPollDelay } from "../lib/relayerBackoff";
import { RELAYER_URL } from "../config/env";

export type RelayerStatus =
  | { state: "missing-url"; message: string }
  | { state: "error"; message: string }
  | { state: "ready"; message: string }
  | { state: "mismatch"; message: string; mismatches: string[]; wrongNetwork?: boolean };

// Relayer URL comes from the single config source.

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
        wrongNetwork:
          !!config.networkPassphrase &&
          config.networkPassphrase !== NETWORK_CONFIG.networkPassphrase,
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
 * True when the relayer submits to a different Stellar network than this
 * build. A proof made here cannot be counted there, so voting is blocked
 * before proving instead of only warning (#751).
 */
export function isWrongNetwork(status: RelayerStatus | null | undefined): boolean {
  return status?.state === "mismatch" && status.wrongNetwork === true;
}

/**
 * Whether a status means the relayer itself is up. A config "mismatch" is a
 * reachable, healthy relayer that disagrees with local config — polling faster
 * or slower won't change that, so it counts as healthy for backoff purposes.
 */
function isRelayerUp(status: RelayerStatus): boolean {
  return status.state === "ready" || status.state === "mismatch";
}

/**
 * React Query hook for relayer status.
 * Replaces useRelayerStatus with caching and automatic refetching.
 *
 * Polls every 60s while the relayer is up; while it is down or degraded the
 * interval backs off exponentially with jitter (#569), so many open clients
 * don't keep hammering a struggling relayer in lockstep.
 */
export function useRelayerStatusQuery() {
  const consecutiveFailuresRef = useRef(0);

  const query = useQuery({
    queryKey: queryKeys.relayer.status(),
    queryFn: async () => {
      try {
        const data = await fetchRelayerStatus();
        consecutiveFailuresRef.current = isRelayerUp(data.status)
          ? 0
          : consecutiveFailuresRef.current + 1;
        return data;
      } catch (err) {
        consecutiveFailuresRef.current += 1;
        throw err;
      }
    },
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: (q) => {
      // The relayer URL is baked in at build time; polling can't fix it.
      if (q.state.data?.status.state === "missing-url") return false;
      return nextRelayerPollDelay(consecutiveFailuresRef.current);
    },
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
