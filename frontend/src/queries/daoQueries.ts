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

export function useDaoInfoQuery({
  daoId,
  publicKey,
  enabled = true,
}: UseDaoInfoQueryOptions) {
  return useQuery({
    queryKey: queryKeys.dao.info(daoId ?? 0),
    queryFn: () => fetchDaoInfo(daoId!, publicKey),
    enabled: enabled && daoId !== null,
    select: (data) => ({
      ...data,
      isAdmin: data.admin === publicKey,
    }),
  });
}

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

interface DAOsListResponse {
  data: DAO[];
  pagination: {
    cursor: string | undefined;
    hasMore: boolean;
    total: number;
  };
  lastSync: string | null;
  cached: boolean;
}

/**
 * Fetch DAO list from relayer API with pagination support.
 */
async function fetchDaosPage(
  userAddress?: string | null,
  cursor?: string,
): Promise<DAOsListResponse> {
  const params = new URLSearchParams();
  if (userAddress) params.set("user", userAddress);
  if (cursor) params.set("cursor", cursor);
  if (params.toString()) {
    params.set("limit", "100");
  }

  const endpoint = `/daos${params.toString() ? `?${params.toString()}` : ""}`;
  const response = await relayerFetch(endpoint);

  if (!response.ok) {
    throw new Error(`Failed to fetch DAOs: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch all DAOs (auto-paginates through all pages).
 */
async function fetchAllDaos(userAddress?: string | null): Promise<DAO[]> {
  const allDaos: DAO[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const result = await fetchDaosPage(userAddress, cursor);
    allDaos.push(...result.data);
    hasMore = result.pagination.hasMore;
    cursor = result.pagination.cursor;
  }

  return allDaos;
}

interface UseDaoListQueryOptions {
  userAddress?: string | null;
  enabled?: boolean;
  pageSize?: number;
}

export function useDaoListQuery({
  userAddress,
  enabled = true,
}: UseDaoListQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.dao.list(userAddress),
    queryFn: () => fetchAllDaos(userAddress),
    enabled,
    staleTime: 30 * 1000,
  });
}

export function useInvalidateDaoList() {
  const queryClient = useQueryClient();

  return (userAddress?: string | null) => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.dao.list(userAddress),
    });
  };
}
