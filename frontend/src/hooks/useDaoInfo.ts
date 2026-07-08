import { useState, useEffect, useCallback } from "react";
import { initializeContractClients } from "../lib/contracts";
import { getReadOnlyDaoRegistry } from "../lib/readOnlyContracts";

interface UseDaoInfoOptions {
  publicKey: string | null;
  daoId: number | null;
  isInitializing?: boolean;
}

interface DaoInfo {
  name: string;
  creator: string;
  isAdmin: boolean;
}

interface UseDaoInfoResult {
  daoInfo: DaoInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Hook to fetch and cache DAO info (name, creator, isAdmin) from the registry.
 * Uses localStorage cache with stale-while-revalidate pattern.
 */
export function useDaoInfo({
  publicKey,
  daoId,
  isInitializing = false,
}: UseDaoInfoOptions): UseDaoInfoResult {
  const cacheKey = daoId ? `dao_info_${daoId}` : null;

  // Initialize with cached DAO info if available
  const [daoInfo, setDaoInfo] = useState<DaoInfo | null>(() => {
    if (cacheKey) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          const cachedDao = JSON.parse(cached);
          return {
            name: cachedDao.name || "",
            creator: cachedDao.creator || "",
            isAdmin: cachedDao.creator === publicKey,
          };
        } catch {
          return null;
        }
      }
    }
    return null;
  });

  // Only show loading if no cache exists
  const [loading, setLoading] = useState(() => {
    if (cacheKey) {
      const cached = localStorage.getItem(cacheKey);
      return !cached;
    }
    return true;
  });

  const [error, setError] = useState<string | null>(null);

  const loadDaoInfo = useCallback(async () => {
    if (!daoId || !cacheKey) return;

    try {
      setError(null);

      // Load from cache first (stale-while-revalidate)
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          const cachedDao = JSON.parse(cached);
          setDaoInfo({
            name: cachedDao.name || "",
            creator: cachedDao.creator || "",
            isAdmin: cachedDao.creator === publicKey,
          });
          setLoading(false);
        } catch {
          // Invalid cache, continue to fetch
        }
      }

      // Fetch fresh data
      let result;
      // Try with wallet client first, fall back to read-only if unfunded
      if (publicKey) {
        try {
          const clients = initializeContractClients(publicKey);
          result = await clients.daoRegistry.get_dao({
            dao_id: BigInt(daoId),
          });
        } catch (err) {
          // If account not found, use read-only client
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

      const newDaoInfo = {
        name: result.result.name,
        creator: result.result.admin,
        isAdmin: result.result.admin === publicKey,
      };
      setDaoInfo(newDaoInfo);

      // Update cache - merge with existing cached data if it exists
      if (cached) {
        try {
          const cachedDao = JSON.parse(cached);
          cachedDao.name = newDaoInfo.name;
          cachedDao.creator = newDaoInfo.creator;
          localStorage.setItem(cacheKey, JSON.stringify(cachedDao));
        } catch {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({
              name: newDaoInfo.name,
              creator: newDaoInfo.creator,
            }),
          );
        }
      } else {
        // Create minimal cache entry
        localStorage.setItem(
          cacheKey,
          JSON.stringify({
            name: newDaoInfo.name,
            creator: newDaoInfo.creator,
          }),
        );
      }
    } catch (err) {
      console.error("Failed to load DAO info:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [daoId, cacheKey, publicKey]);

  useEffect(() => {
    // Wait for wallet initialization before loading
    if (isInitializing) {
      return;
    }
    if (daoId) {
      loadDaoInfo();
    }
  }, [publicKey, daoId, isInitializing, loadDaoInfo]);

  return {
    daoInfo,
    loading,
    error,
    refresh: loadDaoInfo,
  };
}
