/**
 * Privacy-Preserving Analytics query hooks (issue #306).
 *
 * Talks to the analytics routes on the relayer. These read/write the encrypted
 * aggregate tally and privacy-budget accounting; per-voter data is never
 * exposed (see THREAT_MODEL.md §Privacy-Preserving Analytics).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { relayerFetch } from "../lib/api";
import { queryKeys } from "../lib/queryClient";

export interface AnalyticsState {
  daoId: number;
  jointPublicKey: string;
  thresholdT: number;
  thresholdN: number;
  contributionCount: number;
  aggregateC1: string;
  aggregateC2: string;
  decrypted: boolean;
  lastDecryptedTally: string;
  decryptedAt: string | null;
  updatedAt: string;
}

export interface PrivacyBudget {
  daoId: number;
  epsilonBudget: number;
  epsilonSpent: number;
  epsilonPerQuery: number;
  minCohort: number;
  remaining: number;
}

export interface DecryptResult {
  tallyStr: string;
  tally: string;
  proof: string;
  combinedShare: string;
  spentEpsilon: number;
  remainingEpsilon: number;
}

// ── API functions ─────────────────────────────────────────────────────

export async function initializeAnalytics(params: {
  daoId: number;
  jointPublicKey: string;
  thresholdT: number;
  thresholdN: number;
  minCohort?: number;
  epsilonPerQuery?: number;
  epsilonBudget?: number;
}): Promise<{ success: boolean; state: AnalyticsState }> {
  const res = await relayerFetch("/analytics/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to initialize analytics");
  }
  return res.json();
}

export async function accumulateContribution(
  daoId: number,
  c1: string,
  c2: string,
): Promise<{ success: boolean; state: AnalyticsState }> {
  const res = await relayerFetch("/analytics/accumulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daoId, c1, c2 }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to accumulate contribution");
  }
  return res.json();
}

export async function fetchAnalyticsState(
  daoId: number,
): Promise<{ success: boolean; state: AnalyticsState }> {
  const res = await relayerFetch(`/analytics/state/${daoId}`, {
    maxRetries: 1,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to fetch analytics state");
  }
  return res.json();
}

export async function fetchPrivacyBudget(
  daoId: number,
): Promise<{ success: boolean; budget: PrivacyBudget }> {
  const res = await relayerFetch(`/analytics/budget/${daoId}`, {
    maxRetries: 1,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to fetch privacy budget");
  }
  return res.json();
}

export async function decryptAggregate(
  daoId: number,
  shares: Array<{ authorityIndex: number; shareHex: string }>,
): Promise<{ success: boolean; result: DecryptResult }> {
  const res = await relayerFetch("/analytics/decrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daoId, shares }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to decrypt aggregate");
  }
  return res.json();
}

// ── React Query hooks ─────────────────────────────────────────────────

export function useAnalyticsStateQuery(daoId: number) {
  return useQuery({
    queryKey: queryKeys.analytics.state(daoId),
    queryFn: () => fetchAnalyticsState(daoId),
    enabled: daoId > 0,
    staleTime: 10 * 1000,
    retry: 1,
  });
}

export function usePrivacyBudgetQuery(daoId: number) {
  return useQuery({
    queryKey: queryKeys.analytics.budget(daoId),
    queryFn: () => fetchPrivacyBudget(daoId),
    enabled: daoId > 0,
    staleTime: 10 * 1000,
    retry: 1,
  });
}

export function useAccumulateContribution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      daoId,
      c1,
      c2,
    }: {
      daoId: number;
      c1: string;
      c2: string;
    }) => accumulateContribution(daoId, c1, c2),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.analytics.state(vars.daoId),
      });
    },
  });
}

export function useDecryptAggregate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      daoId,
      shares,
    }: {
      daoId: number;
      shares: Array<{ authorityIndex: number; shareHex: string }>;
    }) => decryptAggregate(daoId, shares),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.analytics.state(vars.daoId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.analytics.budget(vars.daoId),
      });
    },
  });
}