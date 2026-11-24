import { useQuery } from "@tanstack/react-query";
import { relayerFetch } from "../lib/api";
import { calculateClaimNullifier, calculateNullifier } from "../lib/zkproof";
import { getZKCredentials } from "../lib/zk";
import { queryKeys } from "../lib/queryClient";

export interface ClaimStatus {
  isClaimed: boolean;
  isVoted: boolean;
  claimNullifier: string;
  voteNullifier: string;
}

async function fetchClaimStatus(
  daoId: number,
  proposalId: number,
  publicKey: string | null,
): Promise<ClaimStatus | null> {
  if (!publicKey) return null;
  const cached = getZKCredentials(daoId, publicKey);
  if (!cached) return null;

  const { secret } = cached;
  const voteNullifier = await calculateNullifier(
    secret,
    daoId.toString(),
    proposalId.toString(),
  );
  const claimNullifier = await calculateClaimNullifier(
    secret,
    daoId.toString(),
    proposalId.toString(),
  );

  // Check authoritative status via relayer (ZV-124: no longer hard-codes isVoted)
  try {
    const toHex = (v: string) => BigInt(v).toString(16).padStart(64, "0");
    const res = await relayerFetch(
      `/api/v1/claim/status/${daoId}/${proposalId}/${toHex(claimNullifier)}/${toHex(voteNullifier)}`,
      {
        maxRetries: 1,
      },
    );
    if (!res.ok) {
      // Fallback to legacy endpoint if new endpoint not available yet
      const legacyRes = await relayerFetch(
        `/api/v1/claim/status/${daoId}/${proposalId}/${toHex(claimNullifier)}`,
        {
          maxRetries: 1,
        },
      );
      if (!legacyRes.ok) {
        return {
          isClaimed: false,
          isVoted: false,
          claimNullifier,
          voteNullifier,
        };
      }
      const legacyData = await legacyRes.json();
      return {
        isClaimed: Boolean(legacyData.isClaimed),
        isVoted: false, // Legacy endpoint doesn't provide this
        claimNullifier,
        voteNullifier,
      };
    }
    const data = await res.json();
    // Now we get authoritative isVoted from on-chain voting contract
    return {
      isClaimed: Boolean(data.isClaimed),
      isVoted: Boolean(data.isVoted),
      claimNullifier,
      voteNullifier,
    };
  } catch {
    return { isClaimed: false, isVoted: false, claimNullifier, voteNullifier };
  }
}

export function useClaimStatusQuery(
  daoId: number,
  proposalId: number,
  publicKey: string | null,
) {
  return useQuery({
    queryKey: queryKeys.claim.status(daoId, proposalId, publicKey ?? "anon"),
    queryFn: () => fetchClaimStatus(daoId, proposalId, publicKey),
    enabled: daoId > 0 && proposalId > 0 && !!publicKey,
    staleTime: 10 * 1000,
    placeholderData: (prev) => prev,
  });
}

export async function submitClaimViaRelayer(params: {
  daoId: number;
  proposalId: number;
  voteNullifier: string;
  claimNullifier: string;
  root: string;
  proof: { a: string; b: string; c: string };
}): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const toHex = (v: string) => BigInt(v).toString(16).padStart(64, "0");
  const res = await relayerFetch("/api/v1/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      daoId: params.daoId,
      proposalId: params.proposalId,
      voteNullifier: toHex(params.voteNullifier),
      claimNullifier: toHex(params.claimNullifier),
      root: toHex(params.root),
      proof: params.proof,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    return { success: false, error: data.error || "Claim failed" };
  }
  return { success: true, txHash: data.txHash };
}

// Treasury query via relayer
async function fetchTreasury(daoId: number): Promise<string> {
  const res = await relayerFetch(`/api/v1/claim/treasury/${daoId}`, {
    maxRetries: 1,
  });
  if (!res.ok) throw new Error("Failed to fetch treasury");
  const data = await res.json();
  return data.treasury ?? "0";
}

export function useTreasuryQuery(daoId: number) {
  return useQuery({
    queryKey: queryKeys.claim.treasury(daoId),
    queryFn: () => fetchTreasury(daoId),
    enabled: daoId > 0,
    staleTime: 30 * 1000,
  });
}
