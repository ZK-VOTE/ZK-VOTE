import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Stale time: how long data is considered fresh (5 minutes)
      staleTime: 5 * 60 * 1000,
      // Cache time: how long to keep unused data in memory (30 minutes)
      gcTime: 30 * 60 * 1000,
      // Retry failed requests up to 2 times
      retry: 2,
      // Refetch on window focus for fresh data
      refetchOnWindowFocus: true,
      // Don't refetch on reconnect by default (can be expensive for contract calls)
      refetchOnReconnect: false,
    },
    mutations: {
      // Retry mutations once
      retry: 1,
    },
  },
});

// Query key factory for type-safe and consistent keys
export const queryKeys = {
  // DAO queries
  dao: {
    all: ["dao"] as const,
    info: (daoId: number) => ["dao", "info", daoId] as const,
    list: (userAddress?: string | null) =>
      userAddress
        ? (["dao", "list", userAddress] as const)
        : (["dao", "list"] as const),
  },

  // Member queries
  members: {
    all: ["members"] as const,
    list: (daoId: number) => ["members", "list", daoId] as const,
    membership: (daoId: number, address: string) =>
      ["members", "membership", daoId, address] as const,
    treeInfo: (daoId: number) => ["members", "treeInfo", daoId] as const,
  },

  // Proposal queries
  proposals: {
    all: ["proposals"] as const,
    list: (daoId: number) => ["proposals", "list", daoId] as const,
    detail: (daoId: number, proposalId: number) =>
      ["proposals", "detail", daoId, proposalId] as const,
    votes: (daoId: number, proposalId: number) =>
      ["proposals", "votes", daoId, proposalId] as const,
  },

  // Relayer queries
  relayer: {
    health: () => ["relayer", "health"] as const,
    config: () => ["relayer", "config"] as const,
    status: () => ["relayer", "status"] as const,
    daos: () => ["relayer", "daos"] as const,
  },

  // Comments queries
  comments: {
    all: ["comments"] as const,
    list: (daoId: number, proposalId: number) =>
      ["comments", "list", daoId, proposalId] as const,
  },
} as const;
