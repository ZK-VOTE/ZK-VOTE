/**
 * Cache Invalidation Utilities
 *
 * Centralized cache invalidation patterns for ZK-VOTE frontend.
 * Addresses Issue #386: Frontend query cache invalidation
 *
 * This module provides:
 * 1. Granular invalidation helpers for specific entities
 * 2. Cascading invalidation for related data (e.g., invalidating proposals also invalidates votes)
 * 3. Automatic invalidation hooks for post-mutation updates
 * 4. Debug utilities for cache inspection
 */

import { queryClient, queryKeys } from "./queryClient";
import type { QueryKey } from "@tanstack/react-query";

/**
 * Invalidation result tracking
 */
interface InvalidationResult {
  keys: QueryKey[];
  count: number;
  timestamp: string;
}

/**
 * Invalidate all DAO-related queries
 * Use after: DAO creation, DAO updates, membership changes
 */
export async function invalidateAllDaoQueries(
  daoId?: number,
): Promise<InvalidationResult> {
  const keys: QueryKey[] = [];

  if (daoId !== undefined) {
    // Invalidate specific DAO
    await queryClient.invalidateQueries({
      queryKey: queryKeys.dao.info(daoId),
    });
    keys.push(queryKeys.dao.info(daoId));

    // Invalidate members for this DAO
    await queryClient.invalidateQueries({
      queryKey: queryKeys.members.list(daoId),
    });
    keys.push(queryKeys.members.list(daoId));

    // Invalidate tree info
    await queryClient.invalidateQueries({
      queryKey: queryKeys.members.treeInfo(daoId),
    });
    keys.push(queryKeys.members.treeInfo(daoId));

    // Invalidate proposals for this DAO
    await queryClient.invalidateQueries({
      queryKey: queryKeys.proposals.list(daoId),
    });
    keys.push(queryKeys.proposals.list(daoId));
  } else {
    // Invalidate all DAO queries (broad invalidation)
    await queryClient.invalidateQueries({
      queryKey: queryKeys.dao.all,
    });
    keys.push(queryKeys.dao.all);
  }

  // Always invalidate DAO list when any DAO changes
  await queryClient.invalidateQueries({
    predicate: (query) =>
      Array.isArray(query.queryKey) && query.queryKey[0] === "dao",
  });

  if (import.meta.env.DEV) {
    console.log(`[Cache] Invalidated ${keys.length} DAO-related queries`, keys);
  }

  return {
    keys,
    count: keys.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Invalidate all proposal-related queries
 * Use after: Vote submission, proposal creation, proposal status changes
 */
export async function invalidateProposalQueries(
  daoId: number,
  proposalId?: number,
): Promise<InvalidationResult> {
  const keys: QueryKey[] = [];

  if (proposalId !== undefined) {
    // Invalidate specific proposal
    await queryClient.invalidateQueries({
      queryKey: queryKeys.proposals.detail(daoId, proposalId),
    });
    keys.push(queryKeys.proposals.detail(daoId, proposalId));

    // Invalidate votes for this proposal
    await queryClient.invalidateQueries({
      queryKey: queryKeys.proposals.votes(daoId, proposalId),
    });
    keys.push(queryKeys.proposals.votes(daoId, proposalId));

    // Invalidate comments for this proposal
    await queryClient.invalidateQueries({
      queryKey: queryKeys.comments.list(daoId, proposalId),
    });
    keys.push(queryKeys.comments.list(daoId, proposalId));
  }

  // Always invalidate proposal list
  await queryClient.invalidateQueries({
    queryKey: queryKeys.proposals.list(daoId),
  });
  keys.push(queryKeys.proposals.list(daoId));

  if (import.meta.env.DEV) {
    console.log(
      `[Cache] Invalidated ${keys.length} proposal-related queries`,
      keys,
    );
  }

  return {
    keys,
    count: keys.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Invalidate membership queries
 * Use after: Member joins, member leaves, role changes
 */
export async function invalidateMembershipQueries(
  daoId: number,
  address?: string,
): Promise<InvalidationResult> {
  const keys: QueryKey[] = [];

  // Invalidate member list
  await queryClient.invalidateQueries({
    queryKey: queryKeys.members.list(daoId),
  });
  keys.push(queryKeys.members.list(daoId));

  // Invalidate tree info (Merkle tree root may have changed)
  await queryClient.invalidateQueries({
    queryKey: queryKeys.members.treeInfo(daoId),
  });
  keys.push(queryKeys.members.treeInfo(daoId));

  if (address) {
    // Invalidate specific membership status
    await queryClient.invalidateQueries({
      queryKey: queryKeys.members.membership(daoId, address),
    });
    keys.push(queryKeys.members.membership(daoId, address));
  }

  // Also invalidate DAO info (membership counts may have changed)
  await queryClient.invalidateQueries({
    queryKey: queryKeys.dao.info(daoId),
  });
  keys.push(queryKeys.dao.info(daoId));

  if (import.meta.env.DEV) {
    console.log(
      `[Cache] Invalidated ${keys.length} membership-related queries`,
      keys,
    );
  }

  return {
    keys,
    count: keys.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Invalidate comment queries
 * Use after: Comment submission, comment deletion
 */
export async function invalidateCommentQueries(
  daoId: number,
  proposalId: number,
): Promise<InvalidationResult> {
  const keys: QueryKey[] = [queryKeys.comments.list(daoId, proposalId)];

  await queryClient.invalidateQueries({
    queryKey: queryKeys.comments.list(daoId, proposalId),
  });

  if (import.meta.env.DEV) {
    console.log(
      `[Cache] Invalidated ${keys.length} comment-related queries`,
      keys,
    );
  }

  return {
    keys,
    count: keys.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Invalidate relayer health/config queries
 * Use after: Configuration changes, network switches
 */
export async function invalidateRelayerQueries(): Promise<InvalidationResult> {
  const keys: QueryKey[] = [
    queryKeys.relayer.health(),
    queryKeys.relayer.config(),
    queryKeys.relayer.status(),
    queryKeys.relayer.daos(),
  ];

  await queryClient.invalidateQueries({
    predicate: (query) =>
      Array.isArray(query.queryKey) && query.queryKey[0] === "relayer",
  });

  if (import.meta.env.DEV) {
    console.log(
      `[Cache] Invalidated ${keys.length} relayer-related queries`,
      keys,
    );
  }

  return {
    keys,
    count: keys.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Clear all React Query caches
 * Use sparingly - for major state changes like wallet disconnect or network switch
 */
export async function clearAllQueryCaches(): Promise<InvalidationResult> {
  const allQueries = queryClient.getQueryCache().getAll();
  const keys = allQueries.map((q) => q.queryKey);

  await queryClient.clear();

  if (import.meta.env.DEV) {
    console.log(`[Cache] Cleared all ${keys.length} query caches`);
  }

  return {
    keys,
    count: keys.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Invalidate claim-related queries
 * Use after: Claim submission, status changes
 * Addresses ZV-125: Cache invalidation consistency
 */
export async function invalidateClaimQueries(
  daoId: number,
  proposalId?: number,
): Promise<InvalidationResult> {
  const keys: QueryKey[] = [];

  if (proposalId !== undefined) {
    // Invalidate specific claim status queries for this proposal
    await queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[0] === "claim" &&
        query.queryKey[1] === "status" &&
        query.queryKey[2] === daoId &&
        query.queryKey[3] === proposalId,
    });
  } else {
    // Invalidate all claim queries for this DAO
    await queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[0] === "claim" &&
        query.queryKey[2] === daoId,
    });
  }

  // Invalidate treasury
  await queryClient.invalidateQueries({
    queryKey: queryKeys.claim.treasury(daoId),
  });
  keys.push(queryKeys.claim.treasury(daoId));

  if (import.meta.env.DEV) {
    console.log(
      `[Cache] Invalidated ${keys.length} claim-related queries`,
      keys,
    );
  }

  return {
    keys,
    count: keys.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Invalidation after successful vote submission
 * Cascades through all related data
 * Enhanced for ZV-125: Now invalidates claim queries too
 */
export async function invalidateAfterVote(
  daoId: number,
  proposalId: number,
): Promise<InvalidationResult> {
  const proposalResult = await invalidateProposalQueries(daoId, proposalId);
  const claimResult = await invalidateClaimQueries(daoId, proposalId);
  
  await queryClient.invalidateQueries({
    queryKey: queryKeys.dao.info(daoId),
  });
  const daoKey = queryKeys.dao.info(daoId);
  const totalCount = proposalResult.count + claimResult.count + 1;

  if (import.meta.env.DEV) {
    console.log(`[Cache] Post-vote invalidation: ${totalCount} queries`);
  }

  return {
    keys: [...proposalResult.keys, ...claimResult.keys, daoKey],
    count: totalCount,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Invalidation after successful claim submission
 * New for ZV-125: Handles claim-specific cache invalidation
 */
export async function invalidateAfterClaim(
  daoId: number,
  proposalId: number,
): Promise<InvalidationResult> {
  const claimResult = await invalidateClaimQueries(daoId, proposalId);
  
  // Also invalidate proposal details (treasury may have changed)
  await queryClient.invalidateQueries({
    queryKey: queryKeys.proposals.detail(daoId, proposalId),
  });
  const proposalKey = queryKeys.proposals.detail(daoId, proposalId);
  
  const totalCount = claimResult.count + 1;

  if (import.meta.env.DEV) {
    console.log(`[Cache] Post-claim invalidation: ${totalCount} queries`);
  }

  return {
    keys: [...claimResult.keys, proposalKey],
    count: totalCount,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Invalidation after DAO creation
 */
export async function invalidateAfterDaoCreation(
  creatorAddress?: string,
): Promise<InvalidationResult> {
  const keys: QueryKey[] = [];

  // Invalidate all DAO lists
  await queryClient.invalidateQueries({
    predicate: (query) =>
      Array.isArray(query.queryKey) &&
      query.queryKey[0] === "dao" &&
      query.queryKey[1] === "list",
  });

  // If we know the creator, invalidate their specific list
  if (creatorAddress) {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.dao.list(creatorAddress),
    });
    keys.push(queryKeys.dao.list(creatorAddress));
  }

  // Invalidate relayer DAO cache
  await queryClient.invalidateQueries({
    queryKey: queryKeys.relayer.daos(),
  });
  keys.push(queryKeys.relayer.daos());

  if (import.meta.env.DEV) {
    console.log(
      `[Cache] Post-DAO-creation invalidation: ${keys.length} queries`,
    );
  }

  return {
    keys,
    count: keys.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Debug utility: Log all active query keys
 */
export function debugQueryCache(): void {
  const cache = queryClient.getQueryCache();
  const queries = cache.getAll();

  console.group(`[Cache Debug] ${queries.length} active queries`);
  queries.forEach((query) => {
    console.log({
      key: query.queryKey,
      state: query.state.status,
      dataUpdatedAt: new Date(query.state.dataUpdatedAt).toISOString(),
      stale: query.isStale(),
    });
  });
  console.groupEnd();
}

/**
 * Debug utility: Get cache statistics
 */
export function getCacheStats() {
  const cache = queryClient.getQueryCache();
  const queries = cache.getAll();

  const stats = {
    total: queries.length,
    byStatus: {
      success: queries.filter((q) => q.state.status === "success").length,
      error: queries.filter((q) => q.state.status === "error").length,
      pending: queries.filter((q) => q.state.status === "pending").length,
    },
    stale: queries.filter((q) => q.isStale()).length,
    fresh: queries.filter((q) => !q.isStale()).length,
  };

  if (import.meta.env.DEV) {
    console.table(stats);
  }

  return stats;
}

/**
 * Hook for automatic cache invalidation after mutations
 * Returns a set of commonly used invalidation functions
 */
export function useInvalidationHelpers() {
  return {
    invalidateAllDaoQueries,
    invalidateProposalQueries,
    invalidateMembershipQueries,
    invalidateCommentQueries,
    invalidateRelayerQueries,
    invalidateClaimQueries,
    invalidateAfterVote,
    invalidateAfterClaim,
    invalidateAfterDaoCreation,
    clearAllQueryCaches,
    debugQueryCache,
    getCacheStats,
  };
}
