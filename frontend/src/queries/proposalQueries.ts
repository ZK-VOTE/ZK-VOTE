import { useQuery, useQueryClient } from "@tanstack/react-query";
import { initializeContractClients } from "../lib/contracts";
import { getReadOnlyVoting } from "../lib/readOnlyContracts";
import { calculateNullifier } from "../lib/zkproof";
import { getZKCredentials } from "../lib/zk";
import { queryKeys } from "../lib/queryClient";
import type { Client as VotingClient } from "../contracts/voting/dist/index.js";

export interface Proposal {
  id: number;
  title: string;
  contentCid: string;
  yesVotes: number;
  noVotes: number;
  hasVoted: boolean;
  eligibleRoot: bigint;
  voteMode: "Fixed" | "Trailing";
  endTime: number;
  vkVersion?: number | null;
}

interface LoadProposalParams {
  daoId: number;
  proposalId: number;
  publicKey: string | null;
}

async function loadProposal({
  daoId,
  proposalId,
  publicKey,
}: LoadProposalParams): Promise<Proposal | null> {
  try {
    const votingClient: VotingClient = publicKey
      ? initializeContractClients(publicKey).voting
      : getReadOnlyVoting();

    const proposalResult = await votingClient.get_proposal({
      dao_id: BigInt(daoId),
      proposal_id: BigInt(proposalId),
    });

    const proposal = proposalResult.result;

    // Check if user has already voted
    let hasVoted = false;
    if (publicKey) {
      try {
        const cached = getZKCredentials(daoId, publicKey);

        if (cached) {
          const { secret } = cached;
          const nullifier = await calculateNullifier(
            secret,
            daoId.toString(),
            proposalId.toString(),
          );

          const nullifierUsedResult = await votingClient.is_nullifier_used({
            dao_id: BigInt(daoId),
            proposal_id: BigInt(proposalId),
            nullifier: BigInt(nullifier),
          });
          hasVoted = nullifierUsedResult.result;
        }
      } catch (err) {
        console.error("Failed to check if voted:", err);
      }
    }

    return {
      id: proposalId,
      title: proposal.title,
      contentCid: proposal.content_cid,
      yesVotes: Number(proposal.yes_votes),
      noVotes: Number(proposal.no_votes),
      hasVoted,
      eligibleRoot: proposal.eligible_root,
      voteMode: proposal.vote_mode.tag as "Fixed" | "Trailing",
      endTime: Number(proposal.end_time),
      vkVersion:
        proposal.vk_version !== undefined ? Number(proposal.vk_version) : null,
    };
  } catch {
    return null;
  }
}

async function fetchProposals(
  daoId: number,
  publicKey: string | null,
): Promise<Proposal[]> {
  // Get proposal count from contract
  const votingClient: VotingClient = publicKey
    ? initializeContractClients(publicKey).voting
    : getReadOnlyVoting();

  let proposalCount = 5; // Default fallback
  try {
    const countResult = await votingClient.proposal_count({
      dao_id: BigInt(daoId),
    });
    proposalCount = Number(countResult.result);
  } catch (err) {
    console.warn("Failed to get proposal count, using default:", err);
  }

  // Load all proposals (IDs start at 1)
  const proposalPromises = [];
  for (let i = 1; i <= proposalCount; i++) {
    proposalPromises.push(loadProposal({ daoId, proposalId: i, publicKey }));
  }

  const loadedProposals = (await Promise.all(proposalPromises)).filter(
    (p): p is Proposal => p !== null,
  );

  // Sort by proposal ID descending (newest first)
  loadedProposals.sort((a, b) => b.id - a.id);

  return loadedProposals;
}

interface UseProposalListQueryOptions {
  daoId: number;
  publicKey: string | null;
  enabled?: boolean;
}

export function useProposalListQuery({
  daoId,
  publicKey,
  enabled = true,
}: UseProposalListQueryOptions) {
  return useQuery({
    queryKey: queryKeys.proposals.list(daoId),
    queryFn: () => fetchProposals(daoId, publicKey),
    enabled: enabled && daoId > 0,
    staleTime: 10 * 1000, // 10 seconds - proposals/votes change often
    // Keep previous data while refetching
    placeholderData: (previousData) => previousData,
  });
}

export function useInvalidateProposals() {
  const queryClient = useQueryClient();

  return (daoId: number) => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.proposals.list(daoId),
    });
  };
}
