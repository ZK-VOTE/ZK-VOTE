import { useEffect, useState } from "react";
import { relayerFetch } from "../lib/api";
import { CONTRACTS } from "../config/contracts";
import { Alert, LoadingSpinner } from "./ui";
import DAOCard from "./ui/DAOCard";
import { fetchDAOMetadata, getImageUrl } from "../lib/daoMetadata";
import type { DAOMetadata } from "../lib/daoMetadata";

interface UserDAO {
  id: number;
  name: string;
  creator: string;
  role: "admin" | "member";
  membership_open: boolean;
  metadata_cid?: string;
}

interface UserDAOListProps {
  userAddress: string;
  onSelectDao: (daoId: number, daoName?: string) => void;
  selectedDaoId?: number | null;
  onDaosLoaded?: (daoIds: number[]) => void;
  isInitializing?: boolean;
}

// Cache key for metadata (still needed for IPFS images)
const getMetadataCacheKey = () =>
  `dao_metadata_${CONTRACTS.REGISTRY_ID.slice(0, 8)}`;

export default function UserDAOList({
  userAddress,
  onSelectDao,
  selectedDaoId,
  onDaosLoaded,
  isInitializing = false,
}: UserDAOListProps) {
  const [daos, setDaos] = useState<UserDAO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Metadata cache is still useful for IPFS images (fetched separately)
  const [metadataCache, setMetadataCache] = useState<
    Record<string, DAOMetadata | null>
  >(() => {
    const cached = localStorage.getItem(getMetadataCacheKey());
    return cached ? JSON.parse(cached) : {};
  });

  useEffect(() => {
    // Wait for wallet to finish initializing before loading
    if (isInitializing) {
      if (import.meta.env.DEV)
        console.log("[UserDAOList] Waiting for wallet initialization...");
      return;
    }
    if (import.meta.env.DEV)
      console.log("[UserDAOList] Loading user DAOs for:", userAddress);
    loadUserDaos();
  }, [userAddress, isInitializing]);

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
  }, [daos]);

  const loadUserDaos = async () => {
    try {
      setError(null);

      // Fetch user DAOs from relayer (checks membership server-side)
      const response = await relayerFetch(`/user/${userAddress}/daos`);

      if (!response.ok) {
        throw new Error(`Failed to fetch user DAOs: ${response.status}`);
      }

      const data = await response.json();
      const fetchedDaos: UserDAO[] = data.daos.map(
        (dao: {
          id: number;
          name: string;
          creator: string;
          membership_open: boolean;
          metadata_cid?: string;
          role: "admin" | "member";
        }) => ({
          id: dao.id,
          name: dao.name,
          creator: dao.creator,
          role: dao.role,
          membership_open: dao.membership_open,
          metadata_cid: dao.metadata_cid,
        }),
      );

      setDaos(fetchedDaos);

      // Notify parent component of loaded DAO IDs
      if (onDaosLoaded) {
        onDaosLoaded(fetchedDaos.map((dao) => dao.id));
      }
    } catch (err) {
      console.error("Failed to load user DAOs:", err);
      setError("Failed to load your DAOs. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Get metadata for a DAO
  const getDAOMetadata = (dao: UserDAO): DAOMetadata | null => {
    if (!dao.metadata_cid) return null;
    return metadataCache[dao.metadata_cid] || null;
  };

  // Get cover image URL - returns null if using default background
  const getCoverImageUrl = (dao: UserDAO): string | null => {
    const metadata = getDAOMetadata(dao);
    if (metadata?.coverImageCid) {
      return getImageUrl(metadata.coverImageCid);
    }
    return null; // Will use CSS background for default
  };

  // Check if DAO has a custom cover image
  const hasCustomCover = (dao: UserDAO): boolean => {
    const metadata = getDAOMetadata(dao);
    return !!metadata?.coverImageCid;
  };

  // Get profile image URL
  const getProfileImageUrl = (dao: UserDAO): string | null => {
    const metadata = getDAOMetadata(dao);
    if (metadata?.profileImageCid) {
      return getImageUrl(metadata.profileImageCid);
    }
    return null;
  };

  if (loading && daos.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          Your DAOs
        </h2>
        <div className="flex items-center justify-center py-8">
          <LoadingSpinner size="md" />
          <span className="ml-3 text-muted-foreground">
            Loading your DAOs...
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          Your DAOs
        </h2>
        <Alert variant="error">{error}</Alert>
        <button
          onClick={loadUserDaos}
          className="mt-4 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // Filter out Public DAO (DAO #1) from user's DAOs
  const filteredDaos = daos.filter((dao) => dao.id !== 1);

  if (filteredDaos.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          Your DAOs
        </h2>
        <div className="text-center py-8">
          <p className="text-muted-foreground mb-4">
            You are not a member or admin of any DAOs yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">
        Your DAOs ({filteredDaos.length})
      </h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {filteredDaos.map((dao) => (
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
            role={dao.role}
          />
        ))}
      </div>
    </div>
  );
}
