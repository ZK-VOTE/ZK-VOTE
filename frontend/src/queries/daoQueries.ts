import { useQuery, useQueryClient } from "@tanstack/react-query";
import { initializeContractClients } from "../lib/contracts";
import { getReadOnlyDaoRegistry } from "../lib/readOnlyContracts";
import { queryKeys } from "../lib/queryClient";
import { relayerFetch } from "../lib/api";

export interface DaoInfo {
  name: string;
  admin: string;
  isAdmin: boolean;
  membershipOpen: boolean;
}

/**
 * Fetch DAO info from the registry contract.
 * Handles both authenticated and read-only modes.
 */
async function fetchDaoInfo(
  daoId: number,
  publicKey: string | null,
): Promise<DaoInfo> {
  let result;

  if (publicKey) {
    try {
      const clients = initializeContractClients(publicKey);
      result = await clients.daoRegistry.get_dao({
        dao_id: BigInt(daoId),
      });
    } catch (err) {
      // If account not found, fall back to read-only client
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (
        errorMessage.includes("Account not found") ||
        errorMessage.includes("does not exist")
      ) {
        const registry = getReadOnlyDaoRegistry();
        result = await registry.get_dao({
          dao_id: BigInt(daoId),
        });
      } else {
        throw err;
      }
    }
  } else {
    // No wallet connected, use read-only
    const registry = getReadOnlyDaoRegistry();
    result = await registry.get_dao({
      dao_id: BigInt(daoId),
    });
  }

  return {
    name: result.result.name,
    admin: result.result.admin,
    isAdmin: result.result.admin === publicKey,
    membershipOpen: result.result.membership_open,
  };
}

interface UseDaoInfoQueryOptions {
  daoId: number | null;
  publicKey: string | null;
  enabled?: boolean;
}

/**
 * React Query hook for fetching DAO info.
 * Replaces the manual useDaoInfo hook with React Query's caching and refetching.
 */
export function useDaoInfoQuery({
  daoId,
  publicKey,
  enabled = true,
}: UseDaoInfoQueryOptions) {
  return useQuery({
    queryKey: queryKeys.dao.info(daoId ?? 0),
    queryFn: () => fetchDaoInfo(daoId!, publicKey),
    enabled: enabled && daoId !== null,
    // Re-compute isAdmin when publicKey changes
    select: (data) => ({
      ...data,
      isAdmin: data.admin === publicKey,
    }),
  });
}

/**
 * Hook to invalidate DAO info cache.
 * Useful after profile updates or admin transfers.
 */
export function useInvalidateDaoInfo() {
  const queryClient = useQueryClient();

  return (daoId: number) => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.dao.info(daoId),
    });
  };
}

// DAO List types
export interface DAO {
  id: number;
  name: string;
  creator: string;
  membership_open: boolean;
  metadata_cid?: string;
  role?: "admin" | "member" | null;
}

interface DAOListResponse {
  daos: DAO[];
}

/**
 * Fetch DAO list from relayer API
 */
async function fetchDaoList(userAddress?: string | null): Promise<DAO[]> {
  const endpoint = userAddress ? `/daos?user=${userAddress}` : "/daos";
  const response = await relayerFetch(endpoint);

  if (!response.ok) {
    throw new Error(`Failed to fetch DAOs: ${response.status}`);
  }

  const data: DAOListResponse = await response.json();
  return data.daos;
}

interface UseDaoListQueryOptions {
  userAddress?: string | null;
  enabled?: boolean;
}

/**
 * React Query hook for fetching DAO list.
 * Supports optional user address for membership filtering.
 */
export function useDaoListQuery({
  userAddress,
  enabled = true,
}: UseDaoListQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.dao.list(userAddress),
    queryFn: () => fetchDaoList(userAddress),
    enabled,
    staleTime: 30 * 1000, // 30 seconds - DAO list changes infrequently
  });
}

/**
 * Hook to invalidate DAO list cache.
 * Useful after creating a new DAO or joining/leaving.
 */
export function useInvalidateDaoList() {
  const queryClient = useQueryClient();

  return (userAddress?: string | null) => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.dao.list(userAddress),
    });
  };
}
