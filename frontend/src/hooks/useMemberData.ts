import { useState, useEffect, useCallback } from "react";
import { initializeContractClients } from "../lib/contracts";
import {
  getReadOnlyDaoRegistry,
  getReadOnlyMembershipSbt,
  getReadOnlyMembershipTree,
  getReadOnlyVoting,
} from "../lib/readOnlyContracts";
import {
  getOrDeriveEncryptionKey,
  encryptAlias,
  decryptAlias,
} from "../lib/encryption";

export interface TreeInfo {
  depth: number;
  leafCount: number;
  root: string;
  vkVersion: number | null;
}

export interface Member {
  address: string;
  hasSBT: boolean;
  registered: boolean;
  isAdmin?: boolean;
}

interface UseMemberDataOptions {
  daoId: number;
  publicKey: string | null;
  isInitializing?: boolean;
  signMessage: (message: string) => Promise<string | Uint8Array>;
}

interface UseMemberDataResult {
  // State
  loading: boolean;
  error: string | null;
  treeInfo: TreeInfo | null;
  members: Member[];
  removedMembers: string[];
  adminAddress: string;
  encryptionKey: Uint8Array | null;
  memberAliases: Map<string, string>;
  encryptedAliases: Map<string, string>;

  // Actions
  refresh: () => Promise<void>;
  setError: (error: string | null) => void;
  setRemovedMembers: React.Dispatch<React.SetStateAction<string[]>>;
  setMembers: React.Dispatch<React.SetStateAction<Member[]>>;
  unlockEncryption: () => Promise<Uint8Array | null>;
  encryptMemberAlias: (alias: string) => string | null;
}

/**
 * Hook for managing member data loading and alias encryption
 */
export function useMemberData({
  daoId,
  publicKey,
  isInitializing = false,
  signMessage,
}: UseMemberDataOptions): UseMemberDataResult {
  // Cache keys
  const treeCacheKey = `tree_info_${daoId}`;
  const membersCacheKey = `members_${daoId}`;

  // State
  const [loading, setLoading] = useState(() => {
    const hasTreeCache = localStorage.getItem(treeCacheKey);
    const hasMembersCache = localStorage.getItem(membersCacheKey);
    return !hasTreeCache && !hasMembersCache;
  });
  const [error, setError] = useState<string | null>(null);
  const [treeInfo, setTreeInfo] = useState<TreeInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [removedMembers, setRemovedMembers] = useState<string[]>([]);
  const [adminAddress, setAdminAddress] = useState<string>("");
  const [encryptionKey, setEncryptionKey] = useState<Uint8Array | null>(null);
  const [memberAliases, setMemberAliases] = useState<Map<string, string>>(
    new Map(),
  );
  const [encryptedAliases, setEncryptedAliases] = useState<Map<string, string>>(
    new Map(),
  );

  // Load encrypted aliases from contract
  const loadEncryptedAliases = useCallback(
    async (memberList: Member[]) => {
      if (memberList.length === 0) return;

      try {
        const membershipSbt = getReadOnlyMembershipSbt();
        const encrypted = new Map<string, string>();

        for (const member of memberList) {
          try {
            const encryptedAlias = await membershipSbt.get_alias({
              dao_id: BigInt(daoId),
              member: member.address,
            });

            if (encryptedAlias.result) {
              encrypted.set(member.address, encryptedAlias.result);
            }
          } catch {
            // Alias may not exist for this member
          }
        }

        setEncryptedAliases(encrypted);
      } catch (err) {
        console.error("Failed to load encrypted aliases:", err);
      }
    },
    [daoId],
  );

  // Decrypt aliases using encryption key
  const decryptAliases = useCallback(
    (key: Uint8Array, aliases: Map<string, string>) => {
      if (aliases.size === 0) return;

      const decrypted = new Map<string, string>();

      for (const [address, encrypted] of aliases) {
        const decryptedValue = decryptAlias(encrypted, key);
        if (decryptedValue) {
          decrypted.set(address, decryptedValue);
        }
      }

      setMemberAliases(decrypted);
    },
    [],
  );

  // Load members from contract
  const loadMembers = useCallback(
    async (admin?: string) => {
      try {
        const membershipSbt = getReadOnlyMembershipSbt();

        const countResult = await membershipSbt.get_member_count({
          dao_id: BigInt(daoId),
        });

        const count = Number(countResult.result);

        if (count === 0) {
          setMembers([]);
          localStorage.setItem(membersCacheKey, JSON.stringify([]));
          return;
        }

        const batchSize = 100;
        const limit = Math.min(batchSize, count);
        const membersResult = await membershipSbt.get_members({
          dao_id: BigInt(daoId),
          offset: BigInt(0),
          limit: BigInt(limit),
        });

        const allMembers: Member[] = [];
        for (const memberAddress of membersResult.result) {
          const hasResult = await membershipSbt.has({
            dao_id: BigInt(daoId),
            of: memberAddress,
          });

          if (hasResult.result) {
            allMembers.push({
              address: memberAddress,
              hasSBT: true,
              registered: false,
              isAdmin: admin ? memberAddress === admin : false,
            });
          }
        }

        setMembers(allMembers);
        localStorage.setItem(membersCacheKey, JSON.stringify(allMembers));

        // Load aliases after members
        await loadEncryptedAliases(allMembers);
      } catch (err) {
        console.error("[loadMembers] Error loading members:", err);
        setError("Failed to load members from contract");
      }
    },
    [daoId, membersCacheKey, loadEncryptedAliases],
  );

  // Load tree info and DAO data
  const loadTreeInfo = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Load from cache first
      const cachedTreeInfo = localStorage.getItem(treeCacheKey);
      const cachedMembers = localStorage.getItem(membersCacheKey);

      if (cachedTreeInfo) {
        const cached = JSON.parse(cachedTreeInfo);
        setTreeInfo({
          depth: cached.treeInfo.depth,
          leafCount: cached.treeInfo.leafCount,
          root: cached.treeInfo.root,
          vkVersion: cached.treeInfo.vkVersion ?? null,
        });
        setAdminAddress(cached.adminAddress);
        setLoading(false);
      }

      if (cachedMembers) {
        const parsedMembers = JSON.parse(cachedMembers);
        setMembers(parsedMembers);
        // Load aliases for cached members
        await loadEncryptedAliases(parsedMembers);
      }

      // Fetch fresh data
      let result;
      let daoResult;
      let vkResult;

      if (publicKey) {
        try {
          const clients = initializeContractClients(publicKey);

          result = await clients.membershipTree.get_tree_info({
            dao_id: BigInt(daoId),
          });

          daoResult = await clients.daoRegistry.get_dao({
            dao_id: BigInt(daoId),
          });

          vkResult = await clients.voting.vk_version({
            dao_id: BigInt(daoId),
          });
        } catch {
          // Account not found - fallback to read-only
          const membershipTree = getReadOnlyMembershipTree();
          const daoRegistry = getReadOnlyDaoRegistry();
          const voting = getReadOnlyVoting();

          result = await membershipTree.get_tree_info({
            dao_id: BigInt(daoId),
          });

          daoResult = await daoRegistry.get_dao({
            dao_id: BigInt(daoId),
          });

          vkResult = await voting.vk_version({
            dao_id: BigInt(daoId),
          });
        }
      } else {
        const membershipTree = getReadOnlyMembershipTree();
        const daoRegistry = getReadOnlyDaoRegistry();
        const voting = getReadOnlyVoting();

        result = await membershipTree.get_tree_info({
          dao_id: BigInt(daoId),
        });

        daoResult = await daoRegistry.get_dao({
          dao_id: BigInt(daoId),
        });

        vkResult = await voting.vk_version({
          dao_id: BigInt(daoId),
        });
      }

      const freshTreeInfo = {
        depth: result?.result?.[0] !== undefined ? Number(result.result[0]) : 0,
        leafCount:
          result?.result?.[1] !== undefined ? Number(result.result[1]) : 0,
        root: result?.result?.[2]?.toString() || "0",
        vkVersion:
          vkResult?.result !== undefined ? Number(vkResult.result) : null,
      };
      setTreeInfo(freshTreeInfo);

      const adminAddr = daoResult.result.admin;
      setAdminAddress(adminAddr);

      localStorage.setItem(
        treeCacheKey,
        JSON.stringify({
          treeInfo: freshTreeInfo,
          adminAddress: adminAddr,
        }),
      );

      await loadMembers(adminAddr);
    } catch (err) {
      console.error("Failed to load tree info:", err);
      setError("Failed to load membership data");
    } finally {
      setLoading(false);
    }
  }, [
    daoId,
    publicKey,
    treeCacheKey,
    membersCacheKey,
    loadMembers,
    loadEncryptedAliases,
  ]);

  // Unlock encryption by deriving key from signature
  const unlockEncryption = useCallback(async (): Promise<Uint8Array | null> => {
    try {
      const key = await getOrDeriveEncryptionKey(daoId, signMessage);
      if (key) {
        setEncryptionKey(key);
        // Decrypt existing aliases
        decryptAliases(key, encryptedAliases);
        return key;
      }
      return null;
    } catch (err) {
      console.error("Failed to unlock encryption:", err);
      return null;
    }
  }, [daoId, signMessage, encryptedAliases, decryptAliases]);

  // Encrypt an alias
  const encryptMemberAlias = useCallback(
    (alias: string): string | null => {
      if (!encryptionKey) return null;
      return encryptAlias(alias, encryptionKey);
    },
    [encryptionKey],
  );

  // Initial load
  useEffect(() => {
    if (isInitializing) return;
    loadTreeInfo();
  }, [daoId, isInitializing, loadTreeInfo]);

  // Decrypt aliases when encryption key becomes available
  useEffect(() => {
    if (encryptionKey && encryptedAliases.size > 0) {
      decryptAliases(encryptionKey, encryptedAliases);
    }
  }, [encryptionKey, encryptedAliases, decryptAliases]);

  return {
    loading,
    error,
    treeInfo,
    members,
    removedMembers,
    adminAddress,
    encryptionKey,
    memberAliases,
    encryptedAliases,
    refresh: loadTreeInfo,
    setError,
    setRemovedMembers,
    setMembers,
    unlockEncryption,
    encryptMemberAlias,
  };
}
