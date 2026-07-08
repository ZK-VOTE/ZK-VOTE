import { useEffect, useState } from "react";
import { useDaoListQuery, type DAO } from "../queries";
import { CONTRACTS } from "../config/contracts";
import { Alert, LoadingSpinner } from "./ui";
import { Card, CardContent } from "./ui/Card";
import DAOCard from "./ui/DAOCard";
import { fetchDAOMetadata, getImageUrl } from "../lib/daoMetadata";
import type { DAOMetadata } from "../lib/daoMetadata";

interface DAOWithMetadata extends DAO {
  metadata?: DAOMetadata | null;
}

interface DAOListProps {
  onSelectDao: (daoId: number, daoName?: string) => void;
  selectedDaoId?: number | null;
  isConnected?: boolean;
  userAddress?: string | null;
  onUserDaosLoaded?: (daoIds: number[]) => void;
  isInitializing?: boolean;
}

// Cache key for metadata (still needed for IPFS images)
const getMetadataCacheKey = () =>
  `dao_metadata_${CONTRACTS.REGISTRY_ID.slice(0, 8)}`;

export default function DAOList({
  onSelectDao,
  selectedDaoId,
  isConnected,
  userAddress,
  onUserDaosLoaded,
  isInitializing = false,
}: DAOListProps) {
  // Metadata cache is still useful for IPFS images (fetched separately)
  const [metadataCache, setMetadataCache] = useState<
    Record<string, DAOMetadata | null>
  >(() => {
    const cached = localStorage.getItem(getMetadataCacheKey());
    return cached ? JSON.parse(cached) : {};
  });

  // Use React Query for DAO list fetching
  const {
    data: daos = [],
    isLoading,
    error,
    refetch,
  } = useDaoListQuery({
    userAddress,
    enabled: !isInitializing,
  });

  // Log when query is enabled
  useEffect(() => {
    if (!isInitializing) {
      if (import.meta.env.DEV)
        console.log(
          "[DAOList] Loading all DAOs",
          userAddress ? `for user ${userAddress.slice(0, 8)}...` : "",
        );
    } else {
      if (import.meta.env.DEV)
        console.log("[DAOList] Waiting for wallet initialization...");
    }
  }, [isInitializing, userAddress]);

  // Notify parent of user's DAOs when data changes
  useEffect(() => {
    if (onUserDaosLoaded && userAddress && daos.length > 0) {
      const userDaoIds = daos
        .filter((dao) => dao.role === "admin" || dao.role === "member")
        .map((dao) => dao.id);
      onUserDaosLoaded(userDaoIds);
    }
  }, [daos, userAddress, onUserDaosLoaded]);

  // Load metadata for DAOs that have metadata_cid
  useEffect(() => {
    const loadMetadata = async () => {
      const daosWithCid = daos.filter(
        (dao) => dao.metadata_cid && !metadataCache[dao.metadata_cid],
      );
      if (daosWithCid.length === 0) return;

      const newCache = { ...metadataCache };

      await Promise.all(
        daosWithCid.map(async (dao) => {
          if (!dao.metadata_cid) return;
          try {
            const metadata = await fetchDAOMetadata(dao.metadata_cid);
            newCache[dao.metadata_cid] = metadata;
          } catch (err) {
            console.warn(`Failed to fetch metadata for DAO ${dao.id}:`, err);
            newCache[dao.metadata_cid!] = null;
          }
        }),
      );

      setMetadataCache(newCache);
      localStorage.setItem(getMetadataCacheKey(), JSON.stringify(newCache));
    };

    loadMetadata();
  }, [daos, metadataCache]);

  // Get metadata for a DAO
  const getDAOMetadata = (dao: DAOWithMetadata): DAOMetadata | null => {
    if (!dao.metadata_cid) return null;
    return metadataCache[dao.metadata_cid] || null;
  };

  // Get cover image URL - returns null if using default background
  const getCoverImageUrl = (dao: DAOWithMetadata): string | null => {
    const metadata = getDAOMetadata(dao);
    if (metadata?.coverImageCid) {
      return getImageUrl(metadata.coverImageCid);
    }
    return null;
  };

  // Check if DAO has a custom cover image
  const hasCustomCover = (dao: DAOWithMetadata): boolean => {
    const metadata = getDAOMetadata(dao);
    return !!metadata?.coverImageCid;
  };

  // Get profile image URL
  const getProfileImageUrl = (dao: DAOWithMetadata): string | null => {
    const metadata = getDAOMetadata(dao);
    if (metadata?.profileImageCid) {
      return getImageUrl(metadata.profileImageCid);
    }
    return null;
  };

  // Separate user's DAOs from other DAOs, always exclude DAO #1 (Public Votes)
  const userDaos = daos
    .filter((dao) => dao.id !== 1)
    .filter((dao) => dao.role === "admin" || dao.role === "member");

  const otherDaos = daos
    .filter((dao) => dao.id !== 1)
    .filter((dao) => dao.role !== "admin" && dao.role !== "member");

  const showUserDaos = isConnected && userAddress && userDaos.length > 0;
  const otherDaosTitle = isConnected ? "Other DAOs" : "All DAOs";

  if (isLoading && daos.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold mb-4">
            {isConnected ? "Loading DAOs..." : "All DAOs"}
          </h2>
          <div className="flex items-center justify-center py-8">
            <LoadingSpinner size="md" />
            <span className="ml-3 text-muted-foreground">Loading DAOs...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold mb-4">DAOs</h2>
          <Alert variant="error">
            {error instanceof Error ? error.message : "Failed to load DAOs"}
          </Alert>
          <button
            onClick={() => refetch()}
            className="mt-4 px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 transition-colors"
          >
            Retry
          </button>
        </CardContent>
      </Card>
    );
  }

  // Show empty state if no DAOs at all
  if (userDaos.length === 0 && otherDaos.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold mb-4">DAOs</h2>
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">
              No DAOs found. Connect your wallet to create the first DAO!
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {/* User's DAOs Section */}
      {showUserDaos && (
        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold mb-4">
              Your DAOs ({userDaos.length})
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {userDaos.map((dao) => (
                <DAOCard
                  key={dao.id}
                  id={dao.id}
                  name={dao.name}
                  membershipOpen={dao.membership_open}
                  isSelected={selectedDaoId === dao.id}
                  coverUrl={getCoverImageUrl(dao)}
                  profileUrl={getProfileImageUrl(dao)}
                  hasCover={hasCustomCover(dao)}
                  onClick={() => onSelectDao(dao.id, dao.name)}
                  role={dao.role || undefined}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Other DAOs Section */}
      {otherDaos.length > 0 && (
        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold mb-4">
              {otherDaosTitle} ({otherDaos.length})
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {otherDaos.map((dao) => (
                <DAOCard
                  key={dao.id}
                  id={dao.id}
                  name={dao.name}
                  membershipOpen={dao.membership_open}
                  isSelected={selectedDaoId === dao.id}
                  coverUrl={getCoverImageUrl(dao)}
                  profileUrl={getProfileImageUrl(dao)}
                  hasCover={hasCustomCover(dao)}
                  onClick={() => onSelectDao(dao.id, dao.name)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state for Other DAOs when connected but all DAOs are user's */}
      {isConnected && otherDaos.length === 0 && userDaos.length > 0 && (
        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold mb-4">Other DAOs</h2>
            <div className="text-center py-8">
              <p className="text-muted-foreground">No other DAOs found.</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
